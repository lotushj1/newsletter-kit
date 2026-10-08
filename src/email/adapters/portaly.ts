import { createHash, randomUUID } from 'node:crypto';
import type { EmailAdapter, EmailAdapterFactory, EmailMessage, SendResult } from '../types.js';

export const DEFAULT_PORTALY_HOST = 'https://portaly.ai';

/** 單一批次最多 100 封（Portaly 的 /batches 上限）。 */
const BATCH_LIMIT = 100;
/** 429/503 時最多自動等 Retry-After 重試幾次。 */
const RATE_LIMIT_RETRIES = 2;
/** Retry-After 超過這個秒數就不等了，交回外層的重試機制。 */
const MAX_WAIT_SECONDS = 30;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    if (ms <= 0) resolve();
    else setTimeout(resolve, ms).unref?.();
  });

interface PortalyInput {
  apiKey: string;
  host: string;
}

function resolveInput(context: { portalyApiKey?: string | undefined; portalyApiHost?: string | undefined }): PortalyInput | { error: string } {
  const apiKey = context.portalyApiKey?.trim() ?? '';
  if (!apiKey) return { error: '缺少 PORTALY_EMAIL_API_KEY（或在後台填入 Portaly 的 API 金鑰）' };
  const host = (context.portalyApiHost?.trim() || DEFAULT_PORTALY_HOST).replace(/\/+$/, '');
  return { apiKey, host };
}

function parseSender(value: string): { email: string; name?: string } {
  const match = value.trim().match(/^(.*)<([^>]+)>\s*$/);
  const email = match?.[2]?.trim();
  if (!email) return { email: value.trim() };
  const name = (match?.[1] ?? '').trim().replace(/^"|"$/g, '');
  return name ? { email, name } : { email };
}

/** Idempotency-Key 與 tag 值只允許英數、底線、連字號。 */
export function sanitizeIdempotencyKey(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 256);
}

/** 把 kit 的 EmailMessage 轉成 POST /api/email/emails 的 body。 */
export function portalyEmailPayload(
  message: EmailMessage,
  idempotencyKey: string,
): Record<string, unknown> {
  const headers: Record<string, string> = { ...(message.headers ?? {}) };
  if (message.unsubscribeUrl) {
    headers['List-Unsubscribe'] = `<${message.unsubscribeUrl}>`;
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }
  return {
    sender: parseSender(message.from),
    recipients: [{ email: message.to }],
    replyTo: message.replyTo,
    subject: message.subject,
    html: message.html,
    text: message.text,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    // 查詢 API 會遮罩收件人，靠這個 tag 才找得回對應的寄送紀錄。
    tags: [{ name: 'ref', value: idempotencyKey }],
  };
}

interface PortalyError {
  status: number;
  code: string | undefined;
  message: string;
  retryAfterSeconds: number | null;
}

async function readError(response: Response): Promise<PortalyError> {
  let code: string | undefined;
  let message = '';
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    code = body.error?.code;
    message = body.error?.message ?? '';
  } catch {
    // 不是 JSON 就只留 status
  }
  const retryAfter = response.headers.get('retry-after');
  const parsed = retryAfter ? Number(retryAfter) : NaN;
  return {
    status: response.status,
    code,
    message,
    retryAfterSeconds: Number.isFinite(parsed) ? parsed : null,
  };
}

/** 哪些錯誤值得之後重試（同一個 Idempotency-Key 不會寄兩次）。 */
function isRetryable(error: PortalyError): boolean {
  if (error.code === 'SEND_QUOTA_EXCEEDED') return false; // 額度用完，重試沒有用
  if (error.code === 'SANDBOX_DAILY_LIMIT_REACHED') return false; // 隔天才會重置
  if (error.status === 429) return true; // RATE_LIMITED
  if (error.status === 409) return true; // IDEMPOTENCY_KEY_IN_USE：稍後用同一個鍵再試
  if (error.status === 502) return true; // SEND_OUTCOME_UNKNOWN：同鍵重試不會重複寄
  if (error.status >= 500) return true;
  return false;
}

function describe(error: PortalyError): string {
  if (error.status === 401) {
    return 'Portaly 401：API 金鑰被拒絕，請確認 PORTALY_EMAIL_API_KEY（pem_ 開頭）還有效';
  }
  if (error.code === 'FORBIDDEN') {
    return 'Portaly 403：Portaly Email 是邀請制 beta，這個帳號尚未開通，請聯絡 Portaly';
  }
  if (error.code === 'SEND_QUOTA_EXCEEDED') {
    return 'Portaly 429：寄信額度不足，請到 Portaly 後台購買額度或等月初重置';
  }
  if (error.code === 'SANDBOX_DAILY_LIMIT_REACHED') {
    return 'Portaly 429：沙箱一天只能寄 50 封，台北時間午夜重置';
  }
  if (error.code === 'RECIPIENT_NOT_ALLOWED') {
    return 'Portaly 403：沙箱寄件人只能寄給帳號本人驗證過的信箱';
  }
  if (error.code === 'HARD_BOUNCE_LIMIT_REACHED') {
    return 'Portaly 403：寄信網域今天退信太多被暫停，請先清理退信名單';
  }
  const detail = [error.code, error.message].filter(Boolean).join(' ');
  return `Portaly ${error.status}${detail ? `: ${detail}` : ''}`.slice(0, 300);
}

/** 可自動等 Retry-After 的次數內，短暫限流就地重試；其餘交給呼叫端。 */
async function postJson(
  input: PortalyInput,
  path: string,
  body: unknown,
  idempotencyKey: string,
): Promise<{ ok: true; raw: unknown } | { ok: false; error: PortalyError }> {
  for (let attempt = 0; ; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(`${input.host}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${input.apiKey}`,
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      return {
        ok: false,
        error: { status: 0, code: 'NETWORK', message: (error as Error).message, retryAfterSeconds: null },
      };
    }
    if (response.ok) {
      try {
        return { ok: true, raw: await response.json() };
      } catch {
        return { ok: true, raw: {} };
      }
    }
    const error = await readError(response);
    const shouldWait =
      (error.code === 'RATE_LIMITED' || error.code === 'SEND_RATE_LIMITED' || error.code === 'RATE_LIMIT_UNAVAILABLE') &&
      attempt < RATE_LIMIT_RETRIES &&
      (error.retryAfterSeconds ?? 1) <= MAX_WAIT_SECONDS;
    if (!shouldWait) return { ok: false, error };
    await sleep((error.retryAfterSeconds ?? 1) * 1000);
  }
}

function toSendResult(outcome: Awaited<ReturnType<typeof postJson>>): SendResult {
  if (outcome.ok) {
    const id = (outcome.raw as { data?: { id?: string } }).data?.id;
    return { ok: true, id };
  }
  if (outcome.error.status === 0) {
    return { ok: false, error: `Portaly 連線失敗：${outcome.error.message}`, retryable: true };
  }
  return { ok: false, error: describe(outcome.error), retryable: isRetryable(outcome.error) };
}

/** 整個批次共用一個冪等鍵；同一組訊息重試會得到同一個鍵。 */
export function batchIdempotencyKey(keys: string[]): string {
  const digest = createHash('sha256').update(keys.join('\n')).digest('hex').slice(0, 40);
  return `nkb-${digest}`;
}

function messageKey(message: EmailMessage): string {
  return sanitizeIdempotencyKey(message.idempotencyKey ?? `nk-${randomUUID()}`);
}

/**
 * Portaly Email adapter：
 * - 單封走 POST /api/email/emails（必帶 Idempotency-Key，重試不會寄兩次）
 * - 批次走 POST /api/email/batches（一次最多 100 封，由 Portaly 背景寄出）
 * - verify 用 GET /api/email/quota 檢查金鑰與剩餘額度
 * 文件：https://portaly.ai/docs（Email 一節）
 */
export const createPortalyAdapter: EmailAdapterFactory = (context): EmailAdapter => ({
  name: 'portaly',

  async verify() {
    const input = resolveInput(context);
    if ('error' in input) return { ok: false, message: `${input.error}。金鑰在 https://portaly.cc/admin/email/api-keys 建立。` };
    try {
      const response = await fetch(`${input.host}/api/email/quota`, {
        headers: { authorization: `Bearer ${input.apiKey}` },
      });
      if (!response.ok) {
        return { ok: false, message: describe(await readError(response)) };
      }
      const body = (await response.json()) as {
        data?: { remaining?: number; sandboxRemainingToday?: number };
      };
      const remaining = body.data?.remaining ?? 0;
      const sandbox = body.data?.sandboxRemainingToday ?? 0;
      return {
        ok: true,
        message: `Portaly 金鑰可用。本月剩餘額度 ${remaining} 封，沙箱今日還可寄 ${sandbox} 封。寄件人需用已驗證網域或 sandbox.portaly.tw。`,
      };
    } catch (error) {
      return { ok: false, message: `無法連到 Portaly：${(error as Error).message}` };
    }
  },

  async send(message) {
    const input = resolveInput(context);
    if ('error' in input) return { ok: false, error: input.error, retryable: false };
    const key = messageKey(message);
    const outcome = await postJson(input, '/api/email/emails', portalyEmailPayload(message, key), key);
    return toSendResult(outcome);
  },

  async sendBatch(messages) {
    const input = resolveInput(context);
    if ('error' in input) {
      return messages.map(() => ({ ok: false as const, error: input.error, retryable: false }));
    }
    if (messages.length === 1) {
      const only = messages[0]!;
      const key = messageKey(only);
      return [toSendResult(await postJson(input, '/api/email/emails', portalyEmailPayload(only, key), key))];
    }

    const results: SendResult[] = [];
    for (let offset = 0; offset < messages.length; offset += BATCH_LIMIT) {
      const chunk = messages.slice(offset, offset + BATCH_LIMIT);
      const keys = chunk.map(messageKey);
      // 批次內不能帶每封的 idempotencyKey，所以 ref tag 照帶、鍵改掛在整個批次上。
      const body = {
        emails: chunk.map((message, index) => portalyEmailPayload(message, keys[index]!)),
      };
      const outcome = await postJson(input, '/api/email/batches', body, batchIdempotencyKey(keys));
      if (!outcome.ok) {
        const failure = toSendResult(outcome) as { ok: false; error: string; retryable?: boolean };
        for (const _ of chunk) results.push({ ...failure });
        continue;
      }
      const ids = (outcome.raw as { data?: { emails?: { id?: string }[] } }).data?.emails ?? [];
      chunk.forEach((_, index) => {
        results.push({ ok: true, id: ids[index]?.id });
      });
    }
    return results;
  },
});

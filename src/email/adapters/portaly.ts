import { createHash, randomUUID } from 'node:crypto';
import type { EmailAdapter, EmailAdapterFactory, EmailMessage, SendResult } from '../types.js';
import { emailHeaders } from '../headers.js';

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

export const PORTALY_SANDBOX_DOMAIN = 'sandbox.portaly.tw';

/** 取出寄件地址的網域（小寫）；解析不出來回傳空字串。 */
export function senderDomain(from: string | undefined): string {
  if (!from) return '';
  const email = parseSender(from).email;
  const at = email.lastIndexOf('@');
  return at >= 0 ? email.slice(at + 1).trim().toLowerCase() : '';
}

interface PortalyDomain {
  host?: string;
  identityStatus?: string;
  mailFromStatus?: string | null;
  status?: string;
}

/**
 * Portaly 沒有「正式／沙箱」開關：寄件網域決定一切。
 * - 寄件人在 sandbox.portaly.tw → 沙箱，只能寄給帳號本人驗證過的信箱，一天 50 封。
 * - 寄件人在自己的網域 → 正式寄送，前提是網域已驗證（DKIM verified + MAIL FROM success），
 *   而且這把金鑰建立時有勾到這個網域（否則 403 DOMAIN_NOT_ALLOWED）。
 * 網域清單要 full 權限的金鑰才讀得到；sending 金鑰會拿到 403，此時只能靠測試信確認。
 */
async function senderMode(input: PortalyInput, from: string | undefined): Promise<{ ok: boolean; message: string }> {
  const domain = senderDomain(from);
  if (!domain) return { ok: true, message: '寄件人需用已驗證網域或 sandbox.portaly.tw。' };
  if (domain === PORTALY_SANDBOX_DOMAIN) {
    return {
      ok: true,
      message: `目前是沙箱模式：寄件人在 ${PORTALY_SANDBOX_DOMAIN}，只能寄給 Portaly 帳號本人驗證過的信箱，一天 50 封。要寄給讀者請改用已驗證的自有網域。`,
    };
  }
  let response: Response;
  try {
    response = await fetch(`${input.host}/api/email/domains`, {
      headers: { authorization: `Bearer ${input.apiKey}` },
    });
  } catch {
    return { ok: true, message: `寄件網域 ${domain}（正式寄送）。暫時查不到網域狀態，請寄一封測試信確認。` };
  }
  if (!response.ok) {
    return {
      ok: true,
      message: `寄件網域 ${domain}（正式寄送）。這把金鑰沒有讀取網域的權限，無法確認網域與金鑰範圍；請寄一封測試信給自己確認，若回 DOMAIN_NOT_ALLOWED 代表金鑰建立時沒勾這個網域，需要重建金鑰。`,
    };
  }
  let domains: PortalyDomain[] = [];
  try {
    const body = (await response.json()) as { data?: PortalyDomain[] };
    domains = Array.isArray(body.data) ? body.data : [];
  } catch {
    domains = [];
  }
  const match = domains.find((item) => item.host?.toLowerCase() === domain);
  if (!match) {
    return {
      ok: false,
      message: `寄件網域 ${domain} 不在這個 Portaly 帳號的寄件網域清單裡，寄出會被拒絕（DOMAIN_NOT_ALLOWED）。請到 https://portaly.cc/admin/email/domains 綁定，或改用已綁定的網域。`,
    };
  }
  const verified = match.identityStatus === 'verified' && match.mailFromStatus === 'success';
  if (match.status && match.status !== 'active') {
    return { ok: false, message: `寄件網域 ${domain} 目前是 ${match.status}，Portaly 不會寄出，請聯絡 Portaly。` };
  }
  if (!verified) {
    return {
      ok: false,
      message: `寄件網域 ${domain} 尚未驗證完成（DKIM ${match.identityStatus ?? '未知'}、MAIL FROM ${match.mailFromStatus ?? '未知'}），寄出會回 DOMAIN_NOT_VERIFIED。請到 https://portaly.cc/admin/email/domains 按「重新檢查」。`,
    };
  }
  return { ok: true, message: `正式寄送：寄件網域 ${domain} 已驗證，可以寄給讀者。` };
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
  const headers = emailHeaders(message);
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
    let quotaLine: string;
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
      quotaLine = `Portaly 金鑰可用。本月剩餘額度 ${remaining} 封，沙箱今日還可寄 ${sandbox} 封。`;
    } catch (error) {
      return { ok: false, message: `無法連到 Portaly：${(error as Error).message}` };
    }
    const mode = await senderMode(input, context.from);
    return { ok: mode.ok, message: `${quotaLine}${mode.message}` };
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

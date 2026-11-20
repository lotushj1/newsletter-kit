import type { EmailAdapter, EmailAdapterFactory, EmailMessage } from '../types.js';
import { emailHeaders } from '../headers.js';

const API = 'https://api.resend.com/emails';

function toPayload(message: EmailMessage): Record<string, unknown> {
  const headers = emailHeaders(message);
  return {
    from: message.from,
    to: [message.to],
    subject: message.subject,
    html: message.html,
    text: message.text,
    reply_to: message.replyTo,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
  };
}

/**
 * 範例 adapter：直接打 Resend REST API，不裝 SDK。
 * 拿它當範本改成你自己的供應商即可。
 */
export const createResendAdapter: EmailAdapterFactory = (context): EmailAdapter => ({
  name: 'resend',

  async verify() {
    if (!context.resendApiKey) return { ok: false, message: '缺少 RESEND_API_KEY。' };
    try {
      const response = await fetch('https://api.resend.com/domains', {
        headers: { authorization: `Bearer ${context.resendApiKey}` },
      });
      if (response.status === 401 || response.status === 403) {
        return { ok: false, message: 'RESEND_API_KEY 被拒絕，請確認金鑰。' };
      }
      return { ok: true, message: 'Resend 金鑰可用。寄件網域仍需在 Resend 後台驗證。' };
    } catch (error) {
      return { ok: false, message: `無法連到 Resend：${(error as Error).message}` };
    }
  },

  async send(message) {
    if (!context.resendApiKey) return { ok: false, error: '缺少 RESEND_API_KEY', retryable: false };
    const headers: Record<string, string> = {
      authorization: `Bearer ${context.resendApiKey}`,
      'content-type': 'application/json',
    };
    // Resend 支援 Idempotency-Key（24 小時內同一把鍵只會寄一次）：帶寄送紀錄 id，重試不會寄兩封。
    if (message.idempotencyKey) headers['idempotency-key'] = message.idempotencyKey.slice(0, 256);
    try {
      const response = await fetch(API, {
        method: 'POST',
        headers,
        body: JSON.stringify(toPayload(message)),
      });
      const raw = await response.text();
      if (!response.ok) {
        // 409：同一把冪等鍵的請求還在處理，或之前用不同內容送過——都可能已經寄出，不能當成沒寄。
        if (response.status === 409 && message.idempotencyKey) {
          return {
            ok: false,
            error: `Resend 409（結果不明）：${raw.slice(0, 300)}`,
            retryable: false,
            outcomeUnknown: true,
          };
        }
        return {
          ok: false,
          error: `Resend ${response.status}: ${raw.slice(0, 300)}`,
          retryable: response.status >= 500 || response.status === 429,
        };
      }
      let id: string | undefined;
      try {
        id = (JSON.parse(raw) as { id?: string }).id;
      } catch {
        id = undefined;
      }
      return { ok: true, id };
    } catch (error) {
      return { ok: false, error: `Resend 連線失敗：${(error as Error).message}`, retryable: true };
    }
  },
});

import type { EmailAdapter, EmailAdapterFactory, EmailMessage } from '../types.js';

const API = 'https://api.resend.com/emails';

function toPayload(message: EmailMessage): Record<string, unknown> {
  const headers: Record<string, string> = { ...(message.headers ?? {}) };
  if (message.unsubscribeUrl) {
    headers['List-Unsubscribe'] = `<${message.unsubscribeUrl}>`;
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }
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
    try {
      const response = await fetch(API, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${context.resendApiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(toPayload(message)),
      });
      const raw = await response.text();
      if (!response.ok) {
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

import type { EmailAdapter, EmailAdapterFactory } from '../types.js';

/**
 * 範例 adapter：把信交給你自己架在 Zeabur（或任何地方）的寄信服務。
 * 預期端點接受 POST JSON { to, from, subject, html, text } 並回 { id }。
 * 你的端點格式不同就改這個檔案，核心不用動。
 */
export const createZeaburAdapter: EmailAdapterFactory = (context): EmailAdapter => ({
  name: 'zeabur',

  async verify() {
    if (!context.zeaburEndpoint) return { ok: false, message: '缺少 ZEABUR_ENDPOINT。' };
    try {
      new URL(context.zeaburEndpoint);
    } catch {
      return { ok: false, message: 'ZEABUR_ENDPOINT 不是有效網址。' };
    }
    return {
      ok: true,
      message: context.zeaburToken
        ? '設定完成，會帶 Bearer token。'
        : '設定完成，但沒有 ZEABUR_TOKEN，端點等於無授權開放。',
    };
  },

  async send(message) {
    if (!context.zeaburEndpoint) {
      return { ok: false, error: '缺少 ZEABUR_ENDPOINT', retryable: false };
    }
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (context.zeaburToken) headers.authorization = `Bearer ${context.zeaburToken}`;

    try {
      const response = await fetch(context.zeaburEndpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          to: message.to,
          from: message.from,
          subject: message.subject,
          html: message.html,
          text: message.text,
          replyTo: message.replyTo,
          unsubscribeUrl: message.unsubscribeUrl,
        }),
      });
      if (!response.ok) {
        return {
          ok: false,
          error: `寄信服務回應 ${response.status}: ${(await response.text()).slice(0, 300)}`,
          retryable: response.status >= 500 || response.status === 429,
        };
      }
      let id: string | undefined;
      try {
        id = (JSON.parse(await response.text()) as { id?: string }).id;
      } catch {
        id = undefined;
      }
      return { ok: true, id };
    } catch (error) {
      return { ok: false, error: `寄信服務連線失敗：${(error as Error).message}`, retryable: true };
    }
  },
});

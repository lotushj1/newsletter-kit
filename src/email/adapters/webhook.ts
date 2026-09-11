import { createHmac } from 'node:crypto';
import type { EmailAdapter, EmailAdapterFactory } from '../types.js';

/**
 * 把每封信 POST 給你自己的服務，由你決定怎麼寄（n8n、Make、自架 API…）。
 * 有設 WEBHOOK_SECRET 時會帶 X-Newsletter-Signature: sha256=<hex>，請在你那端驗簽。
 */
export const createWebhookAdapter: EmailAdapterFactory = (context): EmailAdapter => ({
  name: 'webhook',

  async verify() {
    if (!context.webhookUrl) return { ok: false, message: '缺少 WEBHOOK_URL。' };
    try {
      new URL(context.webhookUrl);
    } catch {
      return { ok: false, message: 'WEBHOOK_URL 不是有效網址。' };
    }
    return {
      ok: true,
      message: context.webhookSecret
        ? 'webhook 設定完成，會帶 HMAC 簽章。'
        : 'webhook 設定完成，但沒有 WEBHOOK_SECRET，對方無法驗簽。',
    };
  },

  async send(message) {
    if (!context.webhookUrl) return { ok: false, error: '缺少 WEBHOOK_URL', retryable: false };

    const body = JSON.stringify({
      to: message.to,
      from: message.from,
      subject: message.subject,
      html: message.html,
      text: message.text,
      replyTo: message.replyTo,
      unsubscribeUrl: message.unsubscribeUrl,
      headers: message.headers,
    });
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (context.webhookSecret) {
      headers['x-newsletter-signature'] = `sha256=${createHmac('sha256', context.webhookSecret)
        .update(body)
        .digest('hex')}`;
    }

    try {
      const response = await fetch(context.webhookUrl, { method: 'POST', headers, body });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 300);
        return {
          ok: false,
          error: `webhook 回應 ${response.status}: ${detail}`,
          retryable: response.status >= 500 || response.status === 429,
        };
      }
      const raw = await response.text();
      let id: string | undefined;
      try {
        id = (JSON.parse(raw) as { id?: string }).id;
      } catch {
        id = undefined;
      }
      return { ok: true, id };
    } catch (error) {
      return { ok: false, error: `webhook 連線失敗：${(error as Error).message}`, retryable: true };
    }
  },
});

import type { EmailAdapter, EmailAdapterFactory } from '../types.js';

const MESSAGE = 'Amazon SES 這版不代簽。要寄出請改用 Webhook，把信交給你的 SES 端點。';

/** 先放在清單裡供測試。真正投遞請走 Webhook，避免送出沒簽章的請求。 */
export const createSesAdapter: EmailAdapterFactory = (): EmailAdapter => ({
  name: 'ses',

  async verify() {
    return { ok: false, message: MESSAGE };
  },

  async send() {
    return { ok: false, error: MESSAGE, retryable: false };
  },
});

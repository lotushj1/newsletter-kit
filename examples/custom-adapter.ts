/**
 * 自訂 Email adapter 範例。
 *
 * 接法：在 src/server.ts 啟動前 import 這個檔案（或把它搬進 src/email/adapters/），
 * 然後把 EMAIL_PROVIDER 設成你註冊的名字。
 */
import { registerEmailAdapter } from '../src/email/registry.js';
import type { EmailAdapter } from '../src/email/types.js';

registerEmailAdapter('my-provider', (context): EmailAdapter => {
  // context 帶的是 .env 裡既有的欄位；要讀自己的變數就直接用 process.env。
  const apiKey = process.env.MY_PROVIDER_API_KEY;
  void context;

  return {
    name: 'my-provider',

    /** 後台「檢查寄信設定」會打這支，回報設定缺什麼。 */
    async verify() {
      if (!apiKey) return { ok: false, message: '缺少 MY_PROVIDER_API_KEY。' };
      return { ok: true, message: '設定看起來沒問題。' };
    },

    async send(message) {
      if (!apiKey) return { ok: false, error: '缺少 MY_PROVIDER_API_KEY', retryable: false };

      const response = await fetch('https://api.my-provider.example/v1/send', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          to: message.to,
          from: message.from,
          subject: message.subject,
          html: message.html,
          text: message.text,
          // 讓收信端能一鍵退訂，投遞率會好一點
          headers: message.unsubscribeUrl
            ? {
                'List-Unsubscribe': `<${message.unsubscribeUrl}>`,
                'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
              }
            : undefined,
        }),
      });

      if (!response.ok) {
        return {
          ok: false,
          error: `供應商回應 ${response.status}`,
          // retryable=true 時 worker 會退避後重試；false 就直接判定失敗
          retryable: response.status >= 500 || response.status === 429,
        };
      }

      const data = (await response.json()) as { id?: string };
      return { ok: true, id: data.id };
    },

    /** 有批次 API 就實作這支，沒有的話核心會自動改用逐封 send。 */
    // async sendBatch(messages) { ... },
  };
});

# newsletter-kit

可自架的電子報管理系統：管名單、寫文、排程、預覽，然後把信交給**你自己接的 Email 服務**送出去。

> ## 這套系統不會幫你寄信
>
> newsletter-kit 沒有內建 SMTP，也不代你送信。它負責的是「寄什麼、寄給誰、什麼時候寄」，
> 真正的投遞由你設定的 **Email adapter** 完成 —— Resend、你自架的寄信服務、n8n、
> 任何吃 webhook 的東西都行。沒有設定 adapter 時預設是 `dry_run`，只會寫 log。
>
> 寄件網域驗證（SPF／DKIM／DMARC）、退信處理、寄送額度，都屬於你選的供應商那一側。

繁體中文介面，MIT 授權，沒有綁任何品牌或第三方帳號。

---

## 有什麼功能

- **寫文**：Markdown 內文、主旨、前導文字（preheader）、草稿、個人化變數
- **名單**：訂閱、雙重確認（double opt-in，可關）、退訂、標籤分組、CSV 匯入匯出
- **排程**：指定時間自動寄出，內建輪詢 worker，批次送 + 失敗退避重試
- **預覽**：後台即時預覽（含未存檔內容）、寄測試信
- **公開端點**：訂閱 API、確認頁、退訂頁、已寄出電子報的封存 API
- **最小後台**：單一 token 登入，不需要另外裝前端

## 不做什麼

不寄信、不做多租戶、沒有使用者帳號系統或權限分級、沒有拖拉式編輯器、
沒有 A／B 測試與開信追蹤、沒有自動化流程（drip）、沒有付費訂閱牆。
需要那些的話，這個專案大概不是你要的東西。

---

## 快速開始

```bash
git clone <this-repo> && cd newsletter-kit
npm install
cp .env.example .env      # 至少改 APP_SECRET 與 ADMIN_TOKEN
npm run dev
```

打開 <http://localhost:4400/admin>，用 `.env` 裡的 `ADMIN_TOKEN` 登入。

預設是 `EMAIL_PROVIDER=dry_run`，不會真的寄出任何東西 —— 先把流程跑一遍，
確認沒問題再換成真的供應商。

需要 Node 20.11 以上。

## 接你自己的 Email 服務

`EMAIL_PROVIDER` 決定用哪個 adapter。

| provider | 用途 | 需要的環境變數 |
| --- | --- | --- |
| `dry_run` | 預設。只寫 log，不寄信 | — |
| `webhook` | 把每封信 POST 給你的服務，你決定怎麼寄 | `WEBHOOK_URL`、`WEBHOOK_SECRET`（選填） |
| `resend` | 範例：直接打 Resend API | `RESEND_API_KEY` |
| `zeabur` | 範例：打你自架的寄信端點 | `ZEABUR_ENDPOINT`、`ZEABUR_TOKEN`（選填） |

`webhook` 是最通用的一條路：不管你用 SES、Postmark、n8n、Make，還是公司內部的寄信服務，
只要寫一個收 POST 的端點就能接上。收到的 JSON 長這樣：

```json
{
  "to": "reader@example.com",
  "from": "Newsletter <hi@yoursite.com>",
  "subject": "九月號",
  "html": "<!doctype html>…",
  "text": "九月號…",
  "replyTo": null,
  "unsubscribeUrl": "https://your-newsletter.example/unsubscribe?token=…"
}
```

有設 `WEBHOOK_SECRET` 時會帶 `X-Newsletter-Signature: sha256=<hex>`（HMAC-SHA256 of raw body），
請在你那端驗簽。回 2xx 代表成功，回 5xx 或 429 會被重試。
可執行的接收端範例在 `examples/webhook-receiver.mjs`。

### 寫自己的 adapter

實作這個介面就好：

```ts
interface EmailAdapter {
  readonly name: string;
  verify(): Promise<{ ok: boolean; message: string }>;
  send(message: EmailMessage): Promise<SendResult>;
  sendBatch?(messages: EmailMessage[]): Promise<SendResult[]>;   // 選配
}
```

```ts
import { registerEmailAdapter } from 'newsletter-kit';

registerEmailAdapter('my-provider', () => ({
  name: 'my-provider',
  async verify() { return { ok: true, message: 'ok' }; },
  async send(message) {
    // 呼叫你的供應商
    return { ok: true, id: 'abc' };
  },
}));
```

然後設 `EMAIL_PROVIDER=my-provider`。完整範例：`examples/custom-adapter.ts`。

回傳 `{ ok: false, retryable: true }` 會讓 worker 退避後重試，`retryable: false` 直接判定失敗。

---

## 接到你自己的官網

### 1. 訂閱表單

```html
<form id="nk-subscribe">
  <input type="email" name="email" required placeholder="you@example.com" />
  <button type="submit">訂閱</button>
</form>
<script>
document.getElementById('nk-subscribe').addEventListener('submit', async (event) => {
  event.preventDefault();
  const response = await fetch('https://your-newsletter.example/api/public/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: event.target.email.value, source: 'website' }),
  });
  const data = await response.json();
  alert(data.message);
});
</script>
```

跨網域記得把官網網域加進 `CORS_ORIGINS`。
可直接開來看的版本在 `examples/embed-form.html`；
不想讓瀏覽器直接打這個服務的話，用 `examples/nextjs-route-proxy.ts` 在自家後端轉一手。

### 2. 確認與退訂

確認信與退訂連結都由這個服務自己出頁面，官網不用實作。
連結用 `APP_SECRET` 簽章（HMAC），不存 token；換掉 secret 會讓已寄出的連結全部失效。

### 3. 封存頁（選用）

```
GET /api/public/campaigns          → { total, items: [{ slug, title, subject, preheader, sentAt }] }
GET /api/public/campaigns/:slug    → { title, subject, sentAt, html }
```

只會回已寄出的內容，個人化變數會換成通用值。

---

## 內文與變數

內文是 Markdown，可用這些變數（主旨、前導文字、內文都支援）：

| 變數 | 說明 |
| --- | --- |
| `{{name}}` | 訂閱者名稱，沒填時是「朋友」 |
| `{{email}}` | 訂閱者 Email |
| `{{site_name}}` | `SITE_NAME` |
| `{{unsubscribe_url}}` | 該收件人的退訂連結 |

變數值會做 HTML escape。信件版型在 `src/core/render.ts` 的 `renderEmailLayout()`，
想換設計改那一個函式就好。頁尾一定會有退訂連結。

## API

公開（可跨網域，有速率限制）：

| 方法 | 路徑 | 說明 |
| --- | --- | --- |
| `POST` | `/api/public/subscribe` | `{ email, name?, tags?, source? }` |
| `POST` | `/api/public/unsubscribe` | `{ token }`，一鍵退訂用 |
| `GET` | `/api/public/campaigns` | 已寄出的電子報列表 |
| `GET` | `/api/public/campaigns/:slug` | 單篇內容 |
| `GET` | `/confirm?token=` · `/unsubscribe?token=` | 給訂閱者看的頁面 |
| `GET` | `/health` | 健康檢查 |

後台（需 `Authorization: Bearer <ADMIN_TOKEN>`，前綴 `/api/admin`）：

| 方法 | 路徑 | 說明 |
| --- | --- | --- |
| `GET` `POST` | `/subscribers` | 列表 / 新增 |
| `PATCH` `DELETE` | `/subscribers/:id` | 更新 / 刪除 |
| `POST` | `/subscribers/import` | `{ csv, tags? }` |
| `GET` | `/subscribers/export.csv` | 匯出 |
| `GET` `POST` | `/campaigns` | 列表 / 新增 |
| `GET` `PATCH` `DELETE` | `/campaigns/:id` | 讀取 / 更新 / 刪除 |
| `POST` | `/campaigns/:id/preview` | 預覽（可帶未存檔內容） |
| `POST` | `/campaigns/:id/test` | `{ email }` 寄測試信 |
| `POST` | `/campaigns/:id/schedule` | `{ scheduledAt }` ISO 時間 |
| `POST` | `/campaigns/:id/unschedule` | 取消排程 |
| `POST` | `/campaigns/:id/send` | 立即寄送（背景執行） |
| `POST` | `/campaigns/:id/cancel` | 中止 |
| `GET` | `/campaigns/:id/deliveries` | 寄送紀錄 |
| `GET` | `/email/verify` | 檢查目前 adapter 設定 |

## 設定

全部走環境變數，完整清單看 `.env.example`。常用的：

| 變數 | 預設 | 說明 |
| --- | --- | --- |
| `APP_SECRET` | — | **正式環境必填**，簽確認／退訂連結 |
| `ADMIN_TOKEN` | — | **正式環境必填**，後台登入 |
| `PUBLIC_BASE_URL` | `http://localhost:4400` | 組信裡連結用的對外網址 |
| `SITE_NAME` | `Newsletter` | 顯示在後台與信件頁尾 |
| `EMAIL_PROVIDER` | `dry_run` | 用哪個 adapter |
| `MAIL_FROM` | — | 寄件人，要是你在供應商驗證過的網域 |
| `STORE_DRIVER` | `sqlite` | `sqlite` / `json` / `memory` |
| `DOUBLE_OPT_IN` | `true` | 關掉就跳過確認信 |
| `CORS_ORIGINS` | `*` | 允許打公開 API 的網域，正式環境請收斂 |
| `SEND_BATCH_SIZE` | `20` | 每批幾封 |
| `SEND_BATCH_DELAY_MS` | `1000` | 批次間隔，配合供應商的速率限制 |
| `SCHEDULER_ENABLED` | `true` | 多台機器時只開一台 |

`NODE_ENV=production` 時若沒設 `APP_SECRET` 或 `ADMIN_TOKEN` 會直接啟動失敗。

## 儲存

預設 SQLite 單檔（`./data/newsletter.db`），部署時記得掛持久磁碟。
`STORE_DRIVER=json` 是零原生依賴的單檔版本，適合小名單試跑。

要換成自己的資料庫就實作 `src/store/types.ts` 的 `Store` 介面，
服務層完全不用改：

```ts
import type { Store } from 'newsletter-kit';

class PostgresStore implements Store { /* … */ }
```

## 部署

任何跑得動 Node 的地方都行：

```bash
npm ci
npm run build
NODE_ENV=production npm start
```

多台機器時，只讓其中一台設 `SCHEDULER_ENABLED=true`，否則排程的電子報會被重複寄出。
或者全部關掉排程器，改用外部 cron 定時觸發。

## 開發

```bash
npm run dev        # tsx watch
npm run typecheck
npm test           # vitest
npm run build
```

```
src/
├── config.ts          環境變數
├── core/              token、markdown、信件版型、CSV、驗證
├── store/             Store 介面 + sqlite / json / memory
├── email/             adapter 介面、registry、內建 adapter
├── services/          訂閱者、電子報、寄送、排程
└── http/              express app、路由、後台頁面
```

## 授權

MIT

# 投遞回報、一鍵退訂與法規資訊

設定 `PUBLIC_BASE_URL` 為公開 HTTPS 網址。以下端點不使用後台登入；每個端點各自驗證簽章或授權。供應商後台只勾選退信、抑制與垃圾信檢舉事件即可。壞簽章回 401，未知事件回 200。硬退信把地址標為 `bounced`，檢舉標為 `unsubscribed`；兩者都寫入持久抑制清單，後續寄送會跳過。軟退信不抑制。相同事件重送可安全重試。既有 Portaly 每 10 分鐘回查仍沿用同一抑制處理。

| 供應商 | webhook URL（接在 `PUBLIC_BASE_URL` 後） | 環境變數與驗證 |
| --- | --- | --- |
| Resend | `/api/webhooks/resend` | `RESEND_WEBHOOK_SECRET`，Svix `whsec_` 簽章；勾選 bounced、suppressed、complained |
| Amazon SES / SNS | `/api/webhooks/ses` | `SES_SNS_TOPIC_ARN`，必須與訊息 TopicArn 相同；驗證 AWS SNS 憑證與 RSA 簽章；只抑制 Permanent Bounce 與 Complaint |
| Postmark | `/api/webhooks/postmark` | `POSTMARK_WEBHOOK_SECRET`，在 webhook URL 設 HTTP Basic 密碼，或用 Bearer／`X-Webhook-Token`；HardBounce、SpamComplaint |
| SendGrid | `/api/webhooks/sendgrid` | `SENDGRID_WEBHOOK_PUBLIC_KEY`，開啟 Signed Event Webhook，填 PEM 或 Base64 P-256 公鑰；bounce、dropped、spamreport |
| Mailgun | `/api/webhooks/mailgun` | `MAILGUN_WEBHOOK_SIGNING_KEY`，驗證 timestamp、token、HMAC；permanent failed、complained |
| Brevo | `/api/webhooks/brevo` | `BREVO_WEBHOOK_SECRET`，在 Brevo webhook 設 Basic 密碼或 Bearer；hard_bounce、blocked、spam |
| Mailchimp Transactional | `/api/webhooks/mailchimp` | `MAILCHIMP_WEBHOOK_KEY`，驗證 `X-Mandrill-Signature`；hard_bounce、reject、spam。簽章包含完整 `PUBLIC_BASE_URL`，網址須與 Mailchimp 設定完全一致 |
| MailerSend | `/api/webhooks/mailersend` | `MAILERSEND_WEBHOOK_SIGNING_SECRET`，驗證 `Signature` HMAC；hard_bounced、spam_complaint、相關 suppressed |
| SparkPost | `/api/webhooks/sparkpost` | `SPARKPOST_WEBHOOK_TOKEN`，設定 `X-MessageSystems-Webhook-Token`；只抑制 bounce class 10、30、90 與 spam_complaint |
| SMTP2GO | `/api/webhooks/smtp2go` | `SMTP2GO_WEBHOOK_SECRET`，設定 Bearer 或 Basic 授權並選 JSON 輸出；只抑制 bounce=hard 與 spam |
| 自訂 adapter／Zeabur relay | `/api/webhooks/generic` | `GENERIC_WEBHOOK_SECRET`，`X-Newsletter-Signature: sha256=<HMAC-SHA256(raw body)>`；JSON `{ "type": "hard_bounce"|"complaint", "email": "…", "providerMessageId": "…" }` |

SNS `SubscriptionConfirmation` 只在驗簽後回 `confirmationRequired: true`，**不會自動開啟**訊息中的 SubscribeURL。管理員須在 AWS 控制台確認訂閱。SNS 憑證只從與 topic region 相同的 AWS SNS HTTPS 主機讀取，不跟隨轉址。`EMAIL_PROVIDER=ses` 本身仍是未實作的發送 adapter；若透過自架 SES relay 投遞，可使用 SNS 端點接回報。

Zeabur 是自架寄信服務的範例，沒有統一的原生回報格式。InsForge SDK 沒有可用的回報 webhook。Postal、Elastic Email、Scaleway 等平台雖有事件功能，但目前沒有經此專案驗證的原生簽章整合；請以自己的驗證 relay 轉成 `/api/webhooks/generic` 的簽名格式。Plunk 的目前整合沒有已驗證的回報格式。這些平台的原生事件不能直接 POST 到 generic 端點，因為簽章格式不同。

## RFC 8058 一鍵退訂

每封電子報與序列信組出：

```text
List-Unsubscribe: <https://your-host/unsubscribe?token=...>, <mailto:leave@example.com>
List-Unsubscribe-Post: List-Unsubscribe=One-Click
```

`mailto:` 僅在 `UNSUBSCRIBE_MAILTO` 有值時加入。郵件用戶端可向這個 URL 發送 `POST`，`Content-Type: application/x-www-form-urlencoded`，內容為 `List-Unsubscribe=One-Click`。伺服器檢查 URL 裡的 `APP_SECRET` HMAC token，直接退訂，重複呼叫回 200，不用 Cookie、CSRF token 或確認頁。一般 GET 仍顯示確認頁，避免連結掃描器誤退訂。

HTTP adapter 會把兩個標頭映射到各供應商 API 的 header 欄位。自訂 webhook 與 Zeabur JSON payload 會帶 `headers` 物件，接收端必須把它寫入實際郵件標頭。MailerSend 的自訂標頭需要 Professional／Enterprise 方案。Brevo API 不接受標準 email header，InsForge SDK 沒有自訂 header 欄位；這兩個 adapter 對需要一鍵退訂的信件會明確回傳失敗，避免無標頭地寄出。Plunk 的此 API 尚未確認支援標頭，同樣拒絕電子報寄送；可用 `EMAIL_PROVIDER=webhook` 接支援原始標頭的寄信服務。

## 頁尾

在後台「設定 → 寄信」編輯實體郵寄地址與隱私權政策網址；Admin API `GET/PATCH /api/admin/brand` 和 MCP `get_brand`／`update_brand` 使用相同資料。`PHYSICAL_ADDRESS` 與 `PRIVACY_URL` 是未儲存時的環境變數備援。程式預設空白地址；`.env.example` 的隱私網址是此部署範例，別的站台應改成自己的政策網址。空白地址會在後台顯示 CAN-SPAM 警告。頁尾和 `{{physical_address}}`、`{{privacy_url}}` 都會使用這兩個值，空白時省略。

## 受眾與點擊報表

電子報可在 `audienceCondition` 傳條件樹，例如：

```json
{ "op": "and", "children": [
  { "op": "tag", "tag": "vip" },
  { "op": "not", "child": { "op": "engagement", "event": "open", "withinDays": 90 } }
] }
```

支援 `and`、`or`、`not`、`tag`、`folder`、`status`、`created`（`after`／`before`）與 `engagement`（`open`／`click`、`campaignId`、`withinDays`、選填 `url`）。舊的 `audienceTags`（任一）與 `audienceFolderId` 仍有效，與條件樹以 AND 合併。`POST /api/admin/campaigns/:id/audience-count` 或 MCP `count_campaign_audience` 預覽人數。條件只從已訂閱且未抑制的人中選。序列信按觸發器及個別訂閱者寄送，沒有額外 audience 欄位。

`GET /api/admin/campaigns/:id/links` 或 MCP `get_campaign_links` 回每個標準化 URL 的 `clicks`、`uniqueClicks`，按總點擊排序；不重複數以訂閱者計。後台電子報已寄出報表有同樣表格。

參考：[AWS SNS 驗簽](https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message-verify-message-signature.html)、[Resend webhook](https://resend.com/changelog/managing-webhooks-via-api)、[SendGrid signed webhook](https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/getting-started-event-webhook-security-features)、[Mailgun webhook](https://documentation.mailgun.com/docs/mailgun/user-manual/events/webhooks)、[Mailchimp Transactional webhook](https://mailchimp.com/developer/transactional/guides/track-respond-activity-webhooks/)。

# 寄信管道能力表

每個 `EMAIL_PROVIDER` 在這個 repo 裡實際做到哪些事。資料來源是 `src/email/adapters/`、`src/http/routes/provider-webhooks.ts`、`src/services/portaly-sync.ts` 的程式碼，供應商 API 的說法來自程式註解、[投遞與法規設定](deliverability.md)，以及標示「未確認」的記憶。

**所有管道都還沒有用真實帳號驗證過。** 下表是「程式送出什麼」，不是「信箱實際收到什麼」。上線前請每個要用的管道各寄一封到自己的信箱，打開原始郵件，確認標頭與純文字版本都在。

## 寄出時帶了什麼

| 管道 | 批次 API | 冪等鍵 | List-Unsubscribe／-Post | 純文字版本 | 限流與錯誤 | 真實帳號驗證 |
| --- | --- | --- | --- | --- | --- | --- |
| `dry_run` | — | — | 不寄出 | 不寄出 | — | 不適用 |
| `webhook` | 否，逐封 | 有：JSON `idempotencyKey` 與 `Idempotency-Key` 標頭，由你的端點去重 | 放在 JSON `headers`，要你的端點寫進信 | 有（`text`） | 429／5xx 重試 | 尚未 |
| `zeabur` | 否，逐封 | 同 `webhook` | 同 `webhook` | 有 | 429／5xx 重試 | 尚未 |
| `resend` | 否，逐封 | 有：`Idempotency-Key`（寄送紀錄 id） | 有（`headers`） | 有（`text`） | 429／5xx 重試；409 視為結果不明 | 尚未 |
| `portaly` | 有：`/batches`，每批最多 100 封、約 1.2 MB | 單封有；批次只能整批一把鍵，見下方 | 有（`headers`） | 有（`text`） | `RATE_LIMITED` 依 `Retry-After` 就地等最多 2 次（30 秒內）；額度用完、沙箱上限不重試；5xx、409、連線失敗視為結果不明 | 尚未 |
| `postmark` | 否 | 沒帶（未確認 API 是否支援） | 有（`Headers`） | 有（`TextBody`） | 429／5xx 重試 | 尚未 |
| `sendgrid` | 否 | 沒帶 | 有（`headers`） | 有（`text/plain`） | 429／5xx 重試 | 尚未 |
| `mailgun` | 否 | 沒帶 | 有（`h:` 欄位） | 有（`text`） | 429／5xx 重試 | 尚未 |
| `brevo` | 否 | 沒帶 | 有（`headers`）；Brevo 是否保留 `List-Unsubscribe-Post` 未確認 | 有（`textContent`） | 429／5xx 重試 | 尚未 |
| `mailchimp`（Mandrill） | 否 | 沒帶 | 有（`headers`） | 有（`text`） | 429／5xx 重試 | 尚未 |
| `sparkpost` | 否 | 沒帶 | 有（`content.headers`） | 有（`text`） | 429／5xx 重試 | 尚未 |
| `mailersend` | 否 | 沒帶 | 有（`headers` 與 `list_unsubscribe`）；自訂標頭需要 Professional／Enterprise 方案 | 有（`text`） | 429／5xx 重試 | 尚未 |
| `plunk` | 否 | 沒帶 | 有（`headers`） | **沒有**：API 只收一份內文（未用真實帳號確認），後台會警告 | 429／5xx 重試 | 尚未 |
| `smtp2go` | 否 | 沒帶 | 有（`custom_headers`） | 有（`text_body`） | 429／5xx 重試 | 尚未 |
| `elasticemail` | 否 | 沒帶 | 有（`Headers`） | 有（`PlainText` 內文，這次補上；之前被丟掉） | 429／5xx 重試 | 尚未 |
| `postal` | 否 | 沒帶 | 有（`headers`） | 有（`plain_body`） | 429／5xx 重試 | 尚未 |
| `scaleway` | 否 | 沒帶 | 有（`additional_headers`）；是否接受這兩個標頭未確認 | 有（`text`） | 429／5xx 重試 | 尚未 |
| `insforge` | 否 | 沒有欄位可帶 | **沒有**：SDK 的寄信欄位只有 to、subject、html、cc、bcc、from、replyTo | **沒有**：同上 | 錯誤訊息含 429、5xx、timeout 時重試 | 尚未 |
| `ses` | — | — | 一封都寄不出去：這版不代簽 AWS，寄送直接失敗 | — | — | 不適用 |

做不到的部分（InsForge 的標頭與純文字、Plunk 的純文字、SES 寄不出去）會在三個地方警告：啟動 log、後台「設定」頁的警告區、後台「檢查寄信設定」（InsForge）。沒有擋下寄送：頁尾退訂連結仍可用，HTML 信照樣送得到。要保證標頭與純文字都在，改用會帶的管道，或用 `webhook` 接你自己的寄信服務。

### 冪等鍵

寄送紀錄 id 就是冪等鍵，同一筆重試永遠用同一把鍵。序列信的寄送紀錄 id 由「入隊 id＋步驟」組成，排程重跑或兩個程序同時跑，鍵都一樣。

- **Portaly 單封**：`Idempotency-Key` 標頭，重試不會寄第二封。
- **Portaly 批次**：程式註解寫明批次 API 不收每封各自的鍵，所以整批共用一把（由這批所有寄送紀錄 id 算出），每封另外帶 `ref` 標籤。同一批原樣重送會被去重；分批方式改變後就是新的鍵，所以批次的保護靠另一層：只要結果可能已被收下（逾時、5xx、409），整批停在「結果不明」不自動重寄，之後用 `ref` 標籤對帳。
- **Resend**：`Idempotency-Key`。憑記憶（沒有在本 repo 的文件裡、這次也沒有查官方文件）：同一把鍵 24 小時內只寄一次，鍵最長 256 字元；同一把鍵還在處理或內容不同時回 409，程式把 409 當成結果不明。
- **Webhook／Zeabur**：鍵交給你的端點，要不要去重由你決定。
- **其他 HTTP 平台、InsForge**：沒有帶。這次沒有確認它們的 API 支不支援，沒有亂加。連線錯誤（請求可能已送出、回應遺失）在這些平台會被當成「可重試」，有重複寄送的風險；Resend 與 Portaly 因為有鍵，重試是安全的。

adapter 本身丟錯（不是回傳失敗）一律當成結果不明，留在 `sending` 等對帳，不會重寄。

## 寄出後的回報

| 管道 | 回報來源與驗證方式 | 退信 | 檢舉 | 已送達 | 對得到哪一筆寄送紀錄 | 查詢／對帳 |
| --- | --- | --- | --- | --- | --- | --- |
| `portaly` | 沒有 webhook，排程定期回查（見下一節） | bounced、suppressed 標成退信並抑制；failed、quota_exceeded、domain_limited 標成沒寄出 | complained：抑制並退訂，寄送紀錄維持已寄出 | 回查只撈有問題的狀態，**已送達只會在對帳時拿到** | 用 Portaly 訊息 id | 有：用 `ref` 標籤查，會帶回收件狀態 |
| `resend` | `/api/webhooks/resend`，Svix 簽章 | email.bounced、email.suppressed | email.complained | 沒有接 | 用 `email_id` | 沒有 |
| `ses`（經你的 relay） | `/api/webhooks/ses`，SNS 憑證與 RSA 簽章＋TopicArn | 只有 Permanent | Complaint | 沒有接 | 用 SES messageId（relay 要把它當 `id` 回傳） | 沒有 |
| `postmark` | `/api/webhooks/postmark`，共用密碼（Basic／Bearer／`X-Webhook-Token`），不是簽章 | HardBounce | SpamComplaint | 沒有接 | 用 MessageID | 沒有 |
| `sendgrid` | `/api/webhooks/sendgrid`，ECDSA 簽章 | bounce、dropped | spamreport | 沒有接 | 對不到：送出時沒拿到訊息 id，只能依地址抑制 | 沒有 |
| `mailgun` | `/api/webhooks/mailgun`，HMAC | permanent failed | complained | 沒有接 | 對不到，只依地址抑制 | 沒有 |
| `brevo` | `/api/webhooks/brevo`，共用密碼 | hard_bounce、blocked | spam、complaint | 沒有接 | 對不到，只依地址抑制 | 沒有 |
| `mailchimp` | `/api/webhooks/mailchimp`，HMAC-SHA1（含完整網址） | hard_bounce、reject | spam | 沒有接 | 對不到，只依地址抑制 | 沒有 |
| `mailersend` | `/api/webhooks/mailersend`，HMAC | hard_bounced、suppressed（hard_bounced） | spam_complaint、suppressed（spam_complained） | 沒有接 | 事件有 message_id，但送出時沒拿到 id，實際對不到 | 沒有 |
| `sparkpost` | `/api/webhooks/sparkpost`，token 標頭或 Basic | bounce class 10、30、90 | spam_complaint | 沒有接 | 對不到，只依地址抑制 | 沒有 |
| `smtp2go` | `/api/webhooks/smtp2go`，共用密碼 | bounce=hard | spam | 沒有接 | 對不到，只依地址抑制 | 沒有 |
| `plunk` | `/api/webhooks/plunk`，Bearer 共用密碼 | Permanent | complainedAt | 沒有接 | 事件有 emailId；送出回應是否帶同一個 id 未確認 | 沒有 |
| `elasticemail` | `/api/webhooks/elasticemail`（GET），網址 token，官方不簽章 | Error＋NoMailbox／BlackListed | AbuseReport | 沒有接 | 用 MessageID（送出回應要帶 `MessageID` 才對得到，未用真實帳號確認） | 沒有 |
| `webhook`、`zeabur`、`postal`、`scaleway` | 沒有原生格式；用自己的 relay 轉成 `/api/webhooks/generic`（HMAC-SHA256） | `hard_bounce`／`bounce` | `complaint` | 沒有接 | 帶 `providerMessageId` 就對得到 | 沒有 |
| `insforge` | 沒有回報 webhook | — | — | — | — | 沒有 |
| `dry_run`、`ses`（直接用） | — | — | — | — | — | — |

「對得到」的回報會記在寄送紀錄上，後台分得出「服務商已收下／已送達／退信／被檢舉／沒寄出／結果不明」。對不到的只做抑制（之後不再寄給那個地址），那筆紀錄會一直顯示「服務商已收下」。軟退信一律不處理。

**開信與點擊不算送達證據。** 追蹤圖可能被預先載入或擋掉，不會拿來改寄送狀態或回報。

## 後台看到的寄送狀態

寄送紀錄的 `status` 管寄送流程與重寄規則，沒有改；服務商的回報另外記在 `receipt`。後台與 API 顯示的狀態由兩者合成：

| 狀態 | 意思 |
| --- | --- |
| 結果不明 | 已交給服務商、但結果沒確認（逾時、5xx、寫回失敗）。不會自動重寄，要對帳 |
| 服務商已收下 | 服務商回應成功，還沒有送達或退信回報。舊資料的「已寄出」都算這一類 |
| 已送達 | 服務商回報送達（目前只有 Portaly 對帳時會拿到） |
| 退信 | 服務商回報退信 |
| 被檢舉為垃圾信 | 服務商回報檢舉；信其實有送達，寄送紀錄維持已寄出 |
| 沒寄出 | 服務商拒收，或收下後回報沒寄出（抑制名單、額度不足…） |

較弱的回報不會蓋掉較強的，例如晚到的「已送達」不會蓋掉「被檢舉」。

- 每封電子報：`GET /api/admin/campaigns/:id/receipts`，後台電子報頁的「寄送回報」卡片。
- 每筆寄送紀錄：`GET /api/admin/campaigns/:id/deliveries?status=sending`（`status` 可省略），每筆帶 `state`。
- 跨電子報的待對帳清單：`GET /api/admin/deliveries/unconfirmed`，後台側欄「待對帳」。

## 等回報要等多久

- **送出當下**：服務商回應成功就是「服務商已收下」；回應不明就是「結果不明」，會一直停在那裡，不會因為時間到了自己變成失敗或重寄。
- **Portaly 回查**：只在排程 tick 有跑時執行，最多每 10 分鐘一次，每次往回看 7 天，只撈有問題的收件狀態，最多 10 頁、每頁 100 筆。查詢失敗時不記這次已跑，下一個 tick 會再試。
  - tick 從哪來：長駐程序每 `SCHEDULER_POLL_MS`（預設 30 秒）跑一次；Vercel 上沒有長駐程序，要靠外部 cron 打 `/api/cron/tick`。repo 附的 Cloudflare Worker 每分鐘打一次、GitHub Actions 每 5 分鐘，`vercel.json` 的每日 cron 只是備援。外部 cron 沒在跑時，實際上最慢一天才回查一次。
  - 7 天後才出現的退信或檢舉，這個 app 不會知道。7 天內有問題的信超過 1,000 封時，超出的部分可能漏掉。
- **Webhook 管道**：事件來了才處理，app 不會主動去問。服務商重送失敗事件的規則各家不同，這裡沒有整理。
- **對帳（手動按鈕）**：從這批結果不明的寄送紀錄裡最早的交件時間往前 10 分鐘開始查。Portaly 每次最多翻 100 頁、每頁 100 封；它的讀取 API 上限是每分鐘 120 次（程式註解）。

## 回報一直沒來時，怎麼查一封信

1. 後台側欄「待對帳」，或 `GET /api/admin/deliveries/unconfirmed`：列出所有結果不明的寄送紀錄，含最早發生時間、電子報、收件人、服務商參考（`ref`＝寄送紀錄 id，有的話加上服務商訊息 id）、對帳狀態，以及最近一次由誰、何時對帳、結果與原因。
2. 按「向寄信服務對帳」。Portaly 會用 `ref` 標籤去查：
   - 查到 → 標成已寄出，記下收件狀態（已送達、被檢舉…）；回報退信或沒寄出的標成失敗。因為有服務商訊息 id，之後重寄失敗的收件人時會跳過它。
   - 查不到、查詢失敗、服務商沒有查詢 API → 維持結果不明，每筆記下原因。**絕不自動重寄。**
3. 沒有查詢 API 的管道，到服務商後台用收件地址與「交給服務商的時間」找。Resend 有服務商訊息 id 時可以直接用 id 查；結果不明的通常沒有 id，只能用地址與時間找。
4. 確認服務商真的沒收到之後：目前後台**沒有**「人工判定沒寄出、排回重寄」的按鈕。結果不明的紀錄會擋住「已寄出」電子報的重寄（「失敗」狀態的電子報仍可重寄其他人，但不會動到結果不明的那幾筆）。需要補寄時，請另外處理，不要直接改資料庫狀態重寄，以免同一人收到兩封。

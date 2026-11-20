# 架設選擇與成本

newsletter-kit **不自己寄信**。成本幾乎都在「寄信供應商 + 一台小主機」，資料庫預設是單機 SQLite。評估時先算兩件事：

1. **訂閱人數**
2. **每月寄出封數**（人數 × 每月期數 + 歡迎信／序列信）

再決定要不要自己管伺服器。以下價格是 2026 年公開方案的約略區間，請以供應商官網為準。

## 怎麼選

| 規模 | 建議 |
| --- | --- |
| 小於 1,000 人、每月少於 3,000 封 | 免費 Resend + SQLite |
| 1,000–10,000 人、每月少於 50,000 封 | Pro 寄信 + SQLite |
| 超過 10,000 人或要多開機 | 同一套程式 + Postgres（自實作 store） |
| 已有 SES／公司 SMTP | `EMAIL_PROVIDER=webhook`，不必換 Resend |
| 想少維運用 BaaS | 可用 InsForge 或同等服務接 webhook／之後的 store driver；**程式不綁死任何一家** |

Mailchimp／ConvertKit 同等名單通常 $50–300／月，還綁他們的編輯器。這套的優點是資料在自己手上，月費主要是寄信費加一台小主機。

## 寄信供應商

真正花錢的地方。kit 只呼叫 adapter，換供應商不用改業務邏輯。

| 情境 | 選擇 | 約略月費 |
| --- | --- | --- |
| 免費試跑 | Resend Free（3,000 封／月、每天 100）或 Zeabur Email Dev（約 $5／月含 3,000 封） | $0–5 |
| 5,000 人、每月 1.5–4 萬封 | Resend Pro（$20、含 50,000 封）或 Zeabur Email Pro（$19、含 50,000 封） | $19–20 |
| 超額 | 兩邊都大約 $0.90／千封 | 按量 |
| 成長到每月約 10 萬封 | Resend Pro $35 或 Zeabur Team $79 | $35–79 |
| 10 萬人、每週全寄（約 40 萬封以上） | Scale／Team 或 SES 自管 | 可能 $200+ |
| 完全自管 | `EMAIL_PROVIDER=webhook` 接到 SES、Postmark、n8n | kit 月費接近 $0，寄信費看 AWS／Postmark |

## 主機與資料庫

- **本機／單一 VPS + SQLite**（預設）：5,000 人完全夠。Zeabur／Fly 一台約 **$5–19／月**。優點便宜、備份一個檔；缺點不好水平擴充。
- **同一套程式 + Postgres**：名單過萬、要開多實例或 MCP 常駐時再加。月費約 **$15–40**。實作 `Store` 介面即可，服務層不用改。
- **BaaS（可選，不是預設）**：`STORE_DRIVER=insforge` 把資料與上傳圖片存在你自己的 InsForge 專案（`INSFORGE_URL` + `INSFORGE_API_KEY`）；名單會長大就用逐表的 `STORE_DRIVER=insforge-tables`（見 [InsForge 逐表 store](insforge-tables.md)）。寄信可另設 `EMAIL_PROVIDER=insforge`（需付費方案）。程式不綁死任何一家，也不內建任何現成專案的金鑰。先依序套用 `migrations/` 裡的 SQL（`npx @insforge/cli db migrations up <版本>`），兩種 driver 都依賴它們。

多台機器時，只讓其中一台設 `SCHEDULER_ENABLED=true`，否則排程與序列信會被重複寄出。

### 正式環境一定要指定持久的資料庫

`NODE_ENV=production` 或在 Vercel 上（`VERCEL=1`）時，下列情況會**直接拒絕啟動**，不會默默把資料寫到隨時會消失的地方：

- 沒有設定 `STORE_DRIVER`
- `STORE_DRIVER=memory`
- Vercel 上用 `sqlite` 或 `json`（只能寫 `/tmp`，重新部署或冷啟動就消失）
- 自架主機的 `STORE_PATH` 放在 `/tmp` 或系統暫存目錄

Vercel 請用 `STORE_DRIVER=insforge-tables`；自架主機可以用 `STORE_DRIVER=sqlite`，`STORE_PATH` 放在持久磁碟。上傳圖片同理：非 InsForge 的 driver 在正式環境把 `UPLOADS_PATH` 放在暫存目錄時，上傳會回 503 並說明原因，不會假裝成功。

只是試跑、可以接受資料隨時消失時，才設 `ALLOW_EPHEMERAL_STORAGE=true`；啟動 log 會留下警告。

## 排程 tick 與運作狀態

Vercel 沒有長駐程序，排程寄送靠外部 cron 帶 `Authorization: Bearer $CRON_SECRET` 打 `POST /api/cron/tick`：

- **Cloudflare Worker**（主要，每分鐘）：見 [`deploy/cloudflare-tick`](../deploy/cloudflare-tick/README.md)，`TICK_URL` 與 `CRON_SECRET` 都用 `wrangler secret put` 設定。
- **GitHub Actions `scheduler-tick`**（備援，每 5 分鐘）：需要 repo variable `TICK_URL` 與 repo secret `CRON_SECRET`。缺任何一個時第一步就失敗並寫明缺什麼，不會發出請求。
- **vercel.json 每日 cron**：Hobby 方案一天只能一次，只當最後備援。

每次 tick 都會把「開始時間、最後一次成功跑完的時間、耗時、落後時間、還沒處理完的量」記在資料庫。後台總覽的「運作狀態」會分開顯示三種狀態：

- **全面寄送暫停**：`SEND_PAUSED=true`，手動、排程、序列信都不寄。
- **排程寄送暫停**：`SCHEDULER_ENABLED=false`，排程電子報與序列信不會自動寄出，手動寄送照常。
- **回執對帳仍啟用**：退信、檢舉的回報（Portaly 回查或寄信服務的 webhook）不受上面兩種暫停影響。

資料庫寫不進去（寫入探測失敗、InsForge 逐表的 schema 版本不符或少了資料表）時，新的公開訂閱回 503（`code: store_unavailable`），寄送與排程也會停下；資料庫恢復後自動解除。

### 給 uptime 監控輪詢

本專案**不會自己發送警報**。請讓 uptime 監控服務（例如 UptimeRobot、Better Stack）定時輪詢下列任一端點，非 200 就通知你：

| 端點 | 授權 | 說明 |
| --- | --- | --- |
| `GET /api/cron/readiness` | `Authorization: Bearer $CRON_SECRET` | 有任何問題回 503。建議用這支，不必把 `ADMIN_TOKEN` 交給監控服務 |
| `GET /api/admin/readiness?strict=1` | `Authorization: Bearer $ADMIN_TOKEN` | 同一份內容；不帶 `strict=1` 一律回 200（後台用） |

回 503 的情況（回應的 `alerts[].code`）：

| code | 意思 |
| --- | --- |
| `store_unavailable` | 資料庫無法讀寫，或 schema 不對 |
| `scheduler_never_ran` | 排程開啟，但還沒有成功跑完的 tick |
| `scheduler_stale` | 上次成功的 tick 超過 15 分鐘 |
| `scheduled_overdue` | 排程電子報超過預定時間 15 分鐘還沒開始寄 |
| `sending_stalled` | 電子報停在「寄送中」超過 30 分鐘沒有進度 |
| `deliveries_unconfirmed` | 寄送紀錄交給寄信服務超過 30 分鐘仍未確認，需要對帳 |
| `send_paused_long` | `SEND_PAUSED=true` 超過 24 小時 |
| `scheduler_disabled_long` | `SCHEDULER_ENABLED=false` 超過 24 小時 |

公開的 `/health` 維持精簡，只回報基本狀態，不含上面這些。

## 約 5,000 人的獨立部署範例

以「約 5,000 位訂閱者、每月 1.5–4 萬封」（週報 + 歡迎／序列信）為例，建議**獨立部署 newsletter-kit**，不要把電子報做進官網。

| 項目 | 建議 |
| --- | --- |
| 應用 | 任何跑得動 Node 20 的平台。已在用 Zeabur 的話，一台 Dev 約 $5，或跟 Email 一起 Pro $19 |
| 寄信 | 優先 Zeabur Email Pro（$19、5 萬封；現有 `zeabur` adapter）或 Resend Pro（$20；現有 `resend` adapter） |
| 資料 | SQLite + 每日備份到物件儲存。5,000 列與寄送紀錄不是問題 |
| 網域 | 例如 `newsletter.example.com` 只給 kit：後台、訂閱頁、追蹤、退訂。官網只 embed 或 POST |
| 月費粗估 | 主機 $5–19 + 寄信 $19–20 ≈ **$25–40** |

成長到 1.5 萬人或每月超過 5 萬封，先升寄信方案，不必重寫系統。名單用 CSV 或簽名匯入 webhook 灌進去。官網、Portaly、任何表單各自在自己那邊接 webhook，**不要把對方的 API key 寫進 kit**。

## 投遞回報與法規資訊

正式寄送前請填真實的 `PHYSICAL_ADDRESS`、自己的 `PRIVACY_URL`，並在供應商設定對應簽名 webhook。電子報與序列信的一鍵退訂及退信抑制細節見 [投遞與法規設定](deliverability.md)。

## 上線步驟：從 dry_run 到正式寄送

照順序做，每一步的通過條件都成立才往下。做過的寄送、排程、設定變更會出現在後台「操作紀錄」。

開始前先確認：`NODE_ENV=production`、`APP_SECRET`、`ADMIN_TOKEN`、`PUBLIC_BASE_URL`（公開 HTTPS 網址）都設好；後台「設定 → 寄信」填了實體郵寄地址與隱私權政策網址。`STORE_DRIVER=insforge-tables` 時，`migrations/` 的 SQL 要依序套用到最新一支（目前是 `20261120230000_create-nk-audit-log.sql`）。

### 1. dry_run 測試信

1. `EMAIL_PROVIDER=dry_run`（預設值），不必設任何寄信金鑰。
2. 後台新增一封電子報，在編輯頁的「測試信」寄給自己（API：`POST /api/admin/campaigns/:id/test`，body `{ "email": "…" }`）。
3. 通過條件：後台回「已透過 dry_run 送出測試信。」；伺服器紀錄有一行 `dry_run 寄信`，帶收件人、主旨與 HTML 大小。這一步不會寄出任何信。
4. 打 `GET /health`：`ok: true`，`store` 是你要的 driver，`provider` 是 `dry_run`。

### 2. 驗證寄件網域

1. 在寄信服務加入寄件網域，照它給的值新增 DNS：
   - **SPF**：網域（或寄信服務指定的 Return-Path 子網域）的 TXT，`include:` 寄信服務。
   - **DKIM**：寄信服務給的 `<selector>._domainkey` CNAME 或 TXT。
   - **DMARC**：`_dmarc.<網域>` 的 TXT，先用 `v=DMARC1; p=none; rua=mailto:<收報告的信箱>`，報告穩定沒問題再改 `quarantine`。
2. 用 `dig +short TXT <網域>`、`dig +short TXT _dmarc.<網域>`、`dig +short TXT <selector>._domainkey.<網域>` 確認查得到；寄信服務後台顯示網域已驗證。
3. `MAIL_FROM` 的網域必須跟 DKIM 簽章的 `d=` 網域，或 SPF 檢查的 Return-Path 網域一致（DMARC 對齊）。用寄信服務的共用網域寄、From 卻寫自己的網域，DMARC 會失敗。
4. 換成正式寄信服務（環境變數或後台「設定 → 寄信」），同時設 `SEND_PAUSED=true`。這時電子報、排程與序列信都不會寄出；測試信與訂閱確認信不受 `SEND_PAUSED` 影響，照常寄出。
5. 寄一封測試信到自己能看原始郵件的信箱（Gmail：信件右上「⋮ → 顯示原始郵件」），確認：
   - `Authentication-Results` 有 `spf=pass`、`dkim=pass`（`header.d=` 是你的網域）、`dmarc=pass`。
   - 有 `List-Unsubscribe: <https://…/unsubscribe?token=…>`（設了 `UNSUBSCRIBE_MAILTO` 時還會帶 `mailto:`）。
   - 有 `List-Unsubscribe-Post: List-Unsubscribe=One-Click`。
   - 兩個退訂標頭有一個不見，代表寄信服務沒把自訂標頭帶出去（InsForge 不支援、Brevo 尚未確認，見 [投遞與法規設定](deliverability.md)），要換服務或改用 `EMAIL_PROVIDER=webhook` 接支援原始標頭的服務。
6. 照 [投遞與法規設定](deliverability.md) 設好退信、檢舉 webhook；簽章錯誤的請求要回 401。

### 3. 測試網域端到端

在**另一個測試部署**跑：自己的資料庫（另一個 SQLite 檔、或 InsForge 的測試 branch／測試專案），`PUBLIC_BASE_URL` 指向測試網址，名單裡只有自己收得到的測試信箱。**不要在正式名單上做這一步：立即寄送與排程會寄給名單裡所有已訂閱的人。**

1. **訂閱**：在 `/join`（或 `POST /api/public/subscribe`）用兩個測試信箱 A、B 訂閱。
2. **確認**：A、B 都收到確認信，點連結後看到「訂閱完成」，後台名單狀態變成已訂閱。
3. **測試信**：寄一封測試信，再檢查一次第 2 步的標頭。
4. **排程**：設 `SEND_PAUSED=false`。長駐程序設 `SCHEDULER_ENABLED=true`；Vercel 測試部署設 `SCHEDULER_ENABLED=true` 與 `CRON_SECRET`，時間到後手動打一次 tick：`curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" <測試網址>/api/cron/tick`（不要改 repo 的 `TICK_URL`，那是正式環境的排程在用）。排一封 5 分鐘後寄出的電子報。
5. **收信**：時間到後 A、B 都收到；後台寄送紀錄是「已寄出」，開信、點擊有數字。
6. **退訂**：A 用信箱的「取消訂閱」按鈕（一鍵退訂）或信尾連結退訂；後台 A 變成已退訂。
7. **下一期不寄**：再寄一封；受眾人數少 1，只有 B 收到，A 沒有寄送紀錄。
8. **退信（選做）**：寄信服務若有退信測試地址，加進名單寄一封，確認名單變成退信、之後也不會寄。

### 4. 開啟正式寄送

1. 正式部署換成第 2 步驗證過的寄信服務與金鑰，先保持 `SEND_PAUSED=true` 部署，寄一封測試信給自己，再檢查一次標頭。
2. 確認名單、寄件人、頁尾地址都對了，再把 `SEND_PAUSED` 改成 `false` 重新部署。
3. 第一期先寄給一個小資料夾或標籤（例如自己人），沒問題再寄全部。
4. 寄完看寄送統計：失敗與「結果不明」都應該是 0。有結果不明的先按「對帳」，不要直接重寄。

### 常見錯誤

| 看到的現象 | 原因 | 處理 |
| --- | --- | --- |
| 按寄送回「寄送已全面暫停（SEND_PAUSED=true），解除前不會寄出任何信」 | `SEND_PAUSED=true` | 確定要寄了再改環境變數、重新部署 |
| 排程時間過了還是「排程中」；`/api/cron/tick` 回 `"skippedReason":"scheduler_disabled"` | `SCHEDULER_ENABLED` 是 false（Vercel 預設） | 設 `SCHEDULER_ENABLED=true` |
| `/api/cron/tick` 回 503「尚未設定 CRON_SECRET」或 401「未授權」 | 沒設 `CRON_SECRET`，或 GitHub secret 跟部署環境的值不同 | 兩邊設同一個值 |
| 「目前沒有符合條件的收件人」 | 名單沒有已訂閱的人（還沒點確認信的是待確認），或篩選條件太窄 | 檢查名單狀態與受眾條件 |
| 「內文還是空的，不能寄送」 | 內文沒存到 | 存檔後再寄 |
| 「排程時間不能是過去」 | 時間已過，或送了沒有時區的時間 | 用含時區的 ISO 時間 |
| 沒收到確認信，伺服器紀錄有「確認信寄送失敗」 | 寄信金鑰錯、寄件網域還沒驗證 | 回到第 2 步 |
| 點確認信回「這個確認連結無效或已過期，請重新訂閱。」 | 超過 14 天，或中間換過 `APP_SECRET` | 重新訂閱；`APP_SECRET` 上線後不要換 |
| 信裡的連結指向 localhost 或錯的網址 | `PUBLIC_BASE_URL` 沒設或設錯 | 改成公開 HTTPS 網址 |
| 原始郵件 `dkim=fail`、`dmarc=fail`，或 Gmail 顯示「透過 … 寄送」 | DNS 還沒生效，或 `MAIL_FROM` 網域跟簽章網域不一致 | 回到第 2 步的 1–3 |
| 原始郵件沒有 `List-Unsubscribe-Post` | 寄信服務沒帶自訂標頭 | 換服務或改用 webhook adapter |
| 重寄時回「還有結果不明的寄送紀錄，請先對帳再重寄」 | 有寄送紀錄停在「寄送中」（已交給寄信服務、結果沒寫回） | 按「對帳」，查到的才會標成已寄出 |
| `/health` 回 503、`storeIntegrity: frozen`；寄送回「資料層完整性異常，已停止寄送」 | 單列快照 driver 偵測到資料異常 | 見 [資料與寄送安全](data-safety.md) |
| 啟動失敗「NODE_ENV=production 時必須設定 APP_SECRET 與 ADMIN_TOKEN。」 | 正式環境缺這兩個變數 | 補上 |
| 啟動失敗「InsForge 資料表尚未建立或無法連線…」 | `insforge-tables` 的 migration 沒套用或金鑰錯 | 套用 `migrations/` |
| 伺服器紀錄「操作紀錄寫入失敗（動作本身已完成）」 | `nk_audit_log` 還沒建立 | 套用 `20261120230000_create-nk-audit-log.sql` |
| 寄信服務的 webhook 回 401 | 簽章或密鑰不符 | 對照 [投遞與法規設定](deliverability.md) 的變數 |

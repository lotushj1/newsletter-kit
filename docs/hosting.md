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

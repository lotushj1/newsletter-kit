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
- **BaaS（可選，不是預設）**：`STORE_DRIVER=insforge` 把資料與上傳圖片存在你自己的 InsForge 專案（`INSFORGE_URL` + `INSFORGE_API_KEY`）。寄信可另設 `EMAIL_PROVIDER=insforge`（需付費方案）。程式不綁死任何一家，也不內建任何現成專案的金鑰。

多台機器時，只讓其中一台設 `SCHEDULER_ENABLED=true`，否則排程與序列信會被重複寄出。

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

# 資料與寄送安全

這份說明 InsForge store 與寄送流程的防護機制。這些機制是為了處理一種已發生過的失敗：在 serverless 環境寄送期間，整份資料被覆寫成空白。

## 這種失敗怎麼發生

InsForge store 把整份資料存成一列 JSON（`nk_snapshots`），每個 serverless 實例各持有一份記憶體快照。舊版有兩個缺陷疊加：

1. **讀到空值就寫空白。** 冷啟動時讀快照得到 `null`（InsForge 暫時回空結果），`init()` 直接寫入空白快照，蓋掉正式資料。
2. **三方合併把「遠端不見」當「遠端刪除」。** 其他實例下一次寫入時，合併邏輯認為遠端刪除了它沒動過的實體，名單、電子報、設定被一起刪掉，只留下它剛改的那一筆。

連帶問題：
- 寄送結果寫回時，寄送紀錄已不存在就靜默略過，信實際寄出了卻沒有紀錄，寄送迴圈也沒停。
- 開信／點擊事件還在、寄送紀錄卻沒了，開信率會算出超過 100%。
- 名單是空的時候按退訂，系統只回「不在名單內」，沒有留下任何紀錄。
- 外部 cron 打 `/api/cron/tick` 時不看 `SCHEDULER_ENABLED`，後台顯示「自動排程關閉」也照樣會寄。

`test/snapshot-wipe-guard.test.ts` 重現了這個情境。

## 資料層防護（`src/store/insforge-store.ts`、`src/store/snapshot-guard.ts`）

結構性的解法是改用逐表的 `STORE_DRIVER=insforge-tables`：不再整份讀寫，也沒有快照可以被覆寫。搬移與回退見 [InsForge 逐表 store](insforge-tables.md)。以下是單列 JSON driver 的防護。

- **不寫空白：** 讀到 `null` 時先用最小查詢確認資料列是否存在；存在就拒絕啟動。全新安裝只用 insert 建立，不可能覆寫既有資料。
- **條件更新：** 寫入時要求 `payload->>__nk_version` 等於剛讀到的版本，不符就重讀、重新合併再寫。
- **損毀偵測：** 遠端版本號倒退，或資料大量消失（集合 ≥5 筆且少掉一半以上）又沒有對應的刪除墓碑，就視為遠端損毀。該實例停止寫入（fail closed），`/health` 回 503 並顯示 `storeIntegrity: frozen`。
- **刪除墓碑：** 每次刪除記下 `[id, version]`（每個集合保留最近 5,000 筆），讓其他實例分辨「正常刪除」與「資料被寫空」。
- **歷史版本：** 每小時第一次寫入前，把寫入前的遠端狀態另存為 `history-YYYYMMDDHH`（同一張表，只新增不覆寫，保留 72 份）。

## 寄送防護（`src/services/sending.ts`）

- **先領取再寄：** 寄信前原子地把寄送紀錄從 `pending` 改成 `sending` 並持久化；只有領到的才交給寄信服務，多個實例不會寄同一筆。
- **寫回核對：** 寄送結果一次寫回並核對筆數，少一筆就丟 `SendRecordError` 停止寄送。
- **結果不明不重寄：** 逾時、5xx、409（Portaly 同一冪等鍵處理中）視為結果不明，留在 `sending`。重寄或續寄都不會碰這些紀錄；用 `POST /admin/api/campaigns/:id/reconcile` 依 ref（= delivery id）向寄信服務對帳，查到才標成已寄出。
- **去重：** 同一個 email 只建立一筆寄送紀錄；重寄失敗的電子報只排回 `failed`／`pending`，同一地址已有 `sent`／`sending` 的會標成 `skipped`。
- **時間預算：** 單次寄送超過 `SEND_TIME_BUDGET_MS`（Vercel 預設 240 秒，函式上限 300 秒）就先收手，佇列保留，用 `POST /admin/api/campaigns/:id/resume` 續寄。
- **退訂排除：** 名單裡找不到的地址按退訂也會記入排除名單；之後還原或匯入名單，寄送時仍會跳過。本人重新訂閱並完成確認才解除。

## 環境變數

| 變數 | 預設 | 作用 |
|---|---|---|
| `SCHEDULER_ENABLED` | 長駐程序 `true`；Vercel `false` | 排程寄送總開關，外部 cron 也遵守。`false` 時 tick 只做投遞狀態回查，不寄任何信。 |
| `SEND_AUTO_RESUME` | `false` | 排程器是否自動接續「寄送中」的電子報。預設不自動續寄：部署、重啟、還原資料後都要人工續寄。 |
| `SEND_TIME_BUDGET_MS` | Vercel `240000`；其他 `0`（不限） | 單次寄送最多跑多久就先收手。 |
| `SEND_PAUSED` | `false` | 全面停止寄送（手動、排程、序列信），只能改環境變數解除。 |

## 統計

開信／點擊只計入對得到「已寄出寄送紀錄」的事件，其餘計為 `orphanEvents`。總覽有 `orphanEvents`、或比率會超過 100% 時，`dataIncomplete` 為 `true`，不回傳比率，儀表板顯示「資料不完整」。

## 補寄對帳工具

`scripts/reconcile-resend.ts`（唯讀、離線，不建立寄信 adapter）。它用清空前的名單備份（InsForge `.sql.gz` 或 payload JSON）與 Portaly 寄送紀錄判斷補寄資格：

- **可補寄：** Portaly 沒有任何一封這期信件的遮罩地址對得上他。
- **已收到：** 同一組遮罩（前兩碼＋網域）的受眾人數等於封數，且全部 delivered。
- **狀態不明：** 其餘全部，不補寄。
- 依寄送順序的推定另列一份名單，必須人工核准。

判斷不使用開信資料；服務商收下（accepted）不等於送達（delivered）。

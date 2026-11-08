# InsForge 逐表 store（`STORE_DRIVER=insforge-tables`）

`STORE_DRIVER=insforge` 把整份資料存在 `nk_snapshots` 的一列 JSON。每次寫入都要讀出整份、三方合併、整份寫回；名單與寄送紀錄越多越慢，也是 2026-11 資料被覆寫成空白那次事故的根源（見 [資料與寄送安全](data-safety.md)）。

`insforge-tables` 改成每種實體一張 Postgres 資料表，透過 `@insforge/sdk` 的 database API 逐列讀寫。

## 差別

| | `insforge`（單列 JSON） | `insforge-tables`（逐表） |
| --- | --- | --- |
| 一次寫入 | 讀整份 → 合併 → 寫整份 | 只寫相關的列 |
| 多個 serverless 實例 | 各自持有快照，靠版本號與合併防覆寫 | 沒有快照，讀到的都是資料庫當下的資料 |
| 領取寄送紀錄 | 整份條件更新，衝突就重來 | `nk_claim_deliveries`：`UPDATE … WHERE status = 'pending'`，只回傳真的改到的列 |
| 寄送結果寫回 | 整份寫回 | `nk_update_deliveries`：一次請求寫回一批，回傳實際存在並更新的 id |
| 刪除電子報、替換序列步驟 | 整份寫回 | 資料庫函式，一個交易完成 |

## 資料表

`migrations/20261108130000_create-nk-entity-tables.sql` 建立：

`nk_subscribers`、`nk_campaigns`、`nk_deliveries`、`nk_events`、`nk_sequences`、`nk_sequence_steps`、`nk_enrollments`、`nk_folders`、`nk_templates`、`nk_settings`、`nk_campaign_starters`，以及統計、領取、批次寫回、連帶刪除用的函式。這支 migration 只新增，不修改、不刪除 `nk_snapshots`。

設計上要知道的幾件事：

- **新欄位不會被丟掉。** 實體上沒有對應欄位的鍵存在該列的 `extra`（jsonb），讀回時合併回去。要拿來查詢或排序的新欄位，再寫 migration 補成正式欄位。
- **時間是 ISO 字串。** 欄位用 `text COLLATE "C"`，比較與排序結果跟 JS 字串比較相同，跟 SQLite／記憶體 store 一致。
- **單次查詢最多 1,000 列。** 這是 InsForge（PostgREST）的上限；讀全部時用 `seq` 做 keyset 分頁。
- **查詢網址約 4KB 就會 502。** `in` 條件依長度切段（`MAX_IN_FILTER_CHARS`）；大批資料一律用 RPC（POST）傳。
- **只給伺服器端存取。** 資料表開 RLS 且沒有 policy；函式撤銷 `PUBLIC` 的執行權限。只有管理金鑰（`INSFORGE_API_KEY`）讀寫得到，跟 `nk_snapshots` 一樣。
- **重送安全。** 每次請求 8 秒逾時、逾時或 5xx 重試。寫入都設計成重送不會出錯：寄送紀錄與事件用 ignoreDuplicates；同一個 claim id 重領會拿回自己剛領到的；新增撞到唯一鍵時，若同 id 的列內容相同就當作上一次已成功。

## 測試

| 指令 | 跑什麼 |
| --- | --- |
| `npm test` | 原本整套測試（MemoryStore），加上新 driver 與搬移腳本的測試（PGlite，真的 Postgres、套用同一支 migration） |
| `npm run test:tables` | 整套測試改用新 driver（PGlite） |
| `NK_TABLES_REMOTE_URL=… NK_TABLES_REMOTE_KEY=… npx vitest run test/insforge-table-store.remote.test.ts` | 打真的 InsForge：多連線並行領取、批次寫回、分頁。**只能指向測試分支或測試專案** |

PGlite 測試介接（`test/support/pglite-table-db.ts`）模擬了 PostgREST 的單次 1,000 列上限與網址長度上限。

## 搬移步驟

以下每一步都在正式專案上執行，**全部需要 Kevin 另外核准**。核准前只能在測試分支或測試專案上演練。

1. **先演練。** 建 schema-only 的 backend branch（`npx -y @insforge/cli branch create <名稱> --mode schema-only`），套用 migration、用合成資料或匿名化的快照跑一次下面 3–6 步。
2. **備份。** `npx -y @insforge/cli backups create --name before-tables --wait`，並另存一份 `nk_snapshots` 的 `default` payload。
3. **套用 migration（正式）。** 在正式專案目錄：
   ```bash
   npx -y @insforge/cli db migrations up 20261108130000_create-nk-entity-tables.sql
   ```
   只新增資料表與函式，現行的 `insforge` driver 不受影響。
4. **暫停寫入。** 設 `SEND_PAUSED=true`、確認沒有排程中或寄送中的電子報，避開訂閱高峰。公開訂閱／退訂／追蹤在切換前仍會寫進 `nk_snapshots`。
5. **搬移與核對。** `INSFORGE_URL`／`INSFORGE_API_KEY` 指向正式專案：
   ```bash
   npx tsx scripts/migrate-snapshot-to-tables.ts --target-host <INSFORGE_URL 的主機名稱>
   npx tsx scripts/migrate-snapshot-to-tables.ts --target-host <INSFORGE_URL 的主機名稱> --apply
   ```
   第一行只檢查（重複 email／slug、缺欄位、筆數）；第二行寫入並核對。報告每張表的「缺少／新表多出／內容不同」都要是 0。檢查沒過就不會寫入。
6. **切換 driver。** Vercel 環境變數改 `STORE_DRIVER=insforge-tables` 並重新部署。打 `/health` 確認 `store` 是 `insforge-tables`；後台抽查名單數、最近幾期的寄送數與開信數。
7. **補切換空檔。** 再跑一次第 5 步的 `--apply`：只補新表沒有的列（空檔裡新增的訂閱者、事件），並把快照裡已退訂／退信、新表仍可寄的人改成退訂。不會覆寫切換後在新表上的修改；「內容不同」會列出筆數供人工確認。
8. **恢復寄送。** 確認無誤再把 `SEND_PAUSED` 改回 `false`。

腳本不會刪除或修改 `nk_snapshots`，輸出只有筆數。`--overwrite` 會用快照覆寫新表上已存在的列，只能在第 6 步之前使用。

## 回退

- **切換後馬上發現問題：** 把 `STORE_DRIVER` 改回 `insforge` 重新部署即可，`nk_snapshots` 沒被動過。但切換後寫進新表的資料（新訂閱、退訂、寄送紀錄、事件）不在快照裡。
- **要把切換後的資料帶回去：** 先匯出新表：
  ```bash
  npx tsx scripts/migrate-snapshot-to-tables.ts --target-host <主機名稱> --export tables-backup.json
  ```
  匯出檔是快照格式（權限 600，含個資，用完刪除）。要不要、怎麼放回 `nk_snapshots` 由 Kevin 決定；放回屬於正式資料還原，需要另外核准。
- **新表本身：** 搬移與回退都不會刪除新表。確定不用時，刪表是另一支需要核准的 migration。

## 需要 Kevin 核准的動作

- 在正式專案套用 migration。
- 對正式專案執行搬移腳本（`--apply`、`--overwrite`）或匯出。
- 修改正式環境的 `STORE_DRIVER`、`SEND_PAUSED` 並部署。
- 任何寄信、補寄、續寄。
- 把匯出檔放回 `nk_snapshots`，或其他正式資料還原。
- 刪除任何資料表或 backend branch 以外的正式資源。

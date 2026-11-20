# 備份與還原

> **狀態：這份還原程序還沒有對真的 InsForge 專案演練過。** 目前只有本機的自動化演練（`test/restore-drill.test.ts`，PGlite）。第一次在測試專案演練完成前，正式環境的 RTO／RPO 都是未知數。

這份以正式環境用的 `STORE_DRIVER=insforge-tables` 為主；SQLite、JSON 與單列快照 driver 另有幾行說明。個人資料的保留期限與刪除見 [個人資料處理](data-handling.md)。

## 資料庫裡的歷史不等於備份

下面這些都存在**同一個資料庫**裡，資料庫或專案出事時會一起不見，不能當備份：

| 機制 | 用途 | 救不了 |
| --- | --- | --- |
| `nk_snapshots` 的 `history-YYYYMMDDHH`（只有單列快照 driver `insforge`） | 快照被寫壞時找回前幾小時的版本（每小時一份，留 72 份） | 資料庫遺失；`insforge-tables` 沒有這個機制 |
| 刪除墓碑（同上） | 分辨正常刪除與「遠端被寫空」 | 不是資料副本 |
| 排除名單（`nk_settings` 裡的 `suppression:<email 的 SHA-256>`） | 退信、檢舉、名單外退訂的人不再寄 | 跟名單在同一個資料庫 |
| 操作紀錄（`nk_audit_log`） | 誰在什麼時候做了寄送、匯出、刪除、還原 | 只記動作，不是資料 |

寄信服務那邊的寄送紀錄、退信與抑制名單也不是你的備份：它們在還原後拿來**對帳**，不能拿來重建名單。

**獨立備份**（資料庫壞掉、專案不見時還在）有兩種，兩種都要有：

1. **InsForge 專案備份**（`npx -y @insforge/cli backups …`）：整個專案的資料庫與 Storage。雲端專案用它還原時，會**覆寫整個專案的資料庫與 Storage**，備份之後寫入的所有東西都會消失，包括同一個專案裡其他服務的資料與上傳的圖片。有沒有自動排程、保留多久依方案而定，請在 InsForge 後台確認；這份文件不假設有自動備份。
2. **逐表匯出檔**（`scripts/migrate-snapshot-to-tables.ts --export`）：把 newsletter-kit 的 `nk_*` 資料表整份匯出成一個 JSON（名單、電子報、寄送紀錄、追蹤事件、自動化、模板、設定與排除名單、操作紀錄）。不含上傳的圖片。匯出檔要存在 InsForge 以外的地方。

其他 driver：

- **SQLite**：備份資料庫檔。WAL 模式下用 `sqlite3 data/newsletter.db ".backup 'newsletter-backup.db'"`，或停服務後連同 `-wal`、`-shm` 一起複製。`UPLOADS_PATH` 的圖片另外備份。
- **JSON**：複製那個檔案。
- **單列快照 `insforge`**：備份 `nk_snapshots` 的 `default` 列（以及還沒併回的 `nk_event_inbox`）。放回快照屬於正式資料還原，見 [資料與寄送安全](data-safety.md)。

## 誰可以備份、誰可以還原

- 匯出檔與專案備份都是整份名單，含 email、退訂與退信紀錄。
- **備份**：發行者，或發行者指定、有這個 InsForge 專案權限的人。逐表匯出要用管理金鑰（`INSFORGE_API_KEY`，等於完整權限），只在自己的電腦執行；金鑰與匯出檔都不能放進 repo、聊天或公開的雲端資料夾。
- **還原**：由發行者決定並核准；對正式專案的任何還原都要事前核准，執行時用 `--actor` 留下自己的名字。
- **匯出檔保管**：腳本會把檔案權限設成 600。加密保存，依 [個人資料處理](data-handling.md) 的備份保留期限到期刪除；演練用完的檔案當天刪除。

## 怎麼備份

### 逐表匯出

```bash
# INSFORGE_URL／INSFORGE_API_KEY 指向要備份的專案
npx tsx scripts/migrate-snapshot-to-tables.ts --target-host <INSFORGE_URL 的主機名稱> --export nk-backup-<日期時間>.json
```

- `--target-host` 必填，而且必須等於 `INSFORGE_URL` 的主機名稱，避免對錯專案執行。
- 只讀資料庫、不寫入；輸出檔權限 600。
- 匯出完成的時間就是這份備份的還原點，記在檔名與維運紀錄裡。匯出是唯讀的，所以不會出現在操作紀錄。
- `nk_audit_log` 還沒建立的專案也能匯出（操作紀錄那一欄是空的）。

### InsForge 專案備份

```bash
npx -y @insforge/cli backups create --name <名稱> --wait
npx -y @insforge/cli backups list
npx -y @insforge/cli backups latest
```

## 還原程序

順序不能換：**停寄送 → 留存現況 → 還原 → 補回還原點之後的退訂與投遞紀錄 → 處理沒寄完的 → 才恢復寄送。**

以下的時間點都要記下來：事故發生 `T_incident`、決定還原 `T_start`、選用的還原點 `T_restore`、恢復寄送 `T_resume`。

### 1. 暫停新的寄送，回報照常

1. 設 `SEND_PAUSED=true` 並重新部署；`GET /health` 要看到 `sendPaused: true`。電子報、排程與自動化序列都不會寄出。
2. **不要**停掉排程 tick（`.github/workflows/scheduler-tick.yml`）與寄信服務的 webhook：`SEND_PAUSED` 時 tick 不寄信，但會照常回查 Portaly 投遞狀態、從 Notion 拉回退訂、併回追蹤事件；退信、檢舉 webhook 也照常寫入。
3. 測試信與訂閱確認信不受 `SEND_PAUSED` 影響。還原期間不要寄測試信；公開訂閱照常進來，第 2 步的匯出會把它們留下來。

### 2. 留存現況

1. 還原**之前**先匯出一份目前的資料：`--export pre-restore-<日期時間>.json`。這份含有還原點之後的退訂、退信、檢舉、新訂閱與寄送紀錄，第 4 步要用。資料表已經讀不到或被清空時，記下這件事，第 4 步改靠寄信服務與其他來源。
2. 從寄信服務匯出 `T_restore` 之後的寄送紀錄與退信／檢舉／抑制名單。
3. 核對完成前，不要刪除出事的專案、branch 或任何匯出檔。

### 3. 還原到選定的時間點

**A. 從 InsForge 專案備份還原（整個專案倒回去）**

```bash
npx -y @insforge/cli backups restore <backupId>
npx -y @insforge/cli projects get   # 等 operation_status 清空
```

整個專案的資料庫與 Storage 會被覆寫，`T_restore` 之後寫入的東西全部消失。

**B. 從逐表匯出檔還原（只動 `nk_*` 資料表）**

```bash
npx tsx scripts/migrate-snapshot-to-tables.ts --target-host <主機名稱> --source-file nk-backup-<日期時間>.json
npx tsx scripts/migrate-snapshot-to-tables.ts --target-host <主機名稱> --source-file nk-backup-<日期時間>.json --apply --actor <你的 email>
```

- 第一行只檢查與核對；第二行寫入。檢查沒過（重複 email、缺欄位）就不會寫入。
- **只新增**：資料表裡已經有的列不覆寫、任何列都不刪除，可以重跑。適合「資料被刪掉、被清空」的情況。
- 資料被改壞（列還在、內容錯）時才考慮 `--overwrite`：它會用備份覆寫已存在的列，也會把還原點之後的合法修改（例如退訂）蓋回去，用了就一定要做第 4 步。操作紀錄一律不會被覆寫。
- 要完整倒回某個時間點（連之後新增的列都刪掉），必須先清空 `nk_*` 資料表；這是另一段需要核准的 SQL，不要在正式專案上臨時手打。
- 寫入後操作紀錄會多一筆「還原／搬移資料」。
- 報告每張表的「缺少」必須是 0。「新表多出」是還原點之後才新增的列；「內容不同」是之後被改過的列，第 4 步逐項處理。

### 4. 補回還原點之後的退訂、檢舉、退信與投遞紀錄

恢復寄送前全部做完。原則：**只往「不寄」的方向補，有疑問就當作不要寄。**

1. **有 pre-restore 匯出檔時**，用只新增模式套回去：
   ```bash
   npx tsx scripts/migrate-snapshot-to-tables.ts --target-host <主機名稱> --source-file pre-restore-<日期時間>.json --apply --actor <你的 email>
   ```
   它會補回還原點之後才新增的訂閱者、寄送紀錄、追蹤事件、排除名單與操作紀錄，並把匯出檔裡已退訂／退信、但還原後仍可寄的人改成退訂（報告的「已從快照同步退訂／退信狀態」）。已存在的列不會被更新：`settings` 的「內容不同」要逐筆看（排除名單的值），寄送紀錄見下面第 4 點。
2. **寄信服務的退信、檢舉、抑制名單**：逐筆對名單。webhook 支援重送的，請寄信服務重送 `T_restore` 之後的事件（重複處理是安全的，見 [投遞與法規設定](deliverability.md)）；不能重送的，在後台把那些人改成已退訂或退信。
3. **其他退訂來源**：`UNSUBSCRIBE_MAILTO` 信箱裡 `T_restore` 之後的退訂信；Notion 會員資料庫（反向同步會在下一次 tick 把 Notion 已退訂的人改成退訂，被暫停時到總覽按「套用這些退訂」）。
4. **寄送紀錄**：`T_restore` 之後有寄過的每一封電子報，拿寄信服務的寄送紀錄比對（寄送紀錄 id 就是寄給寄信服務的 ref）。寄信服務已經收下、但還原後還是 `pending` 的，**不能續寄**；目前後台沒有按鈕能把 pending 改成已寄出，這種電子報不要按「繼續寄送」，改按「中止寄送」（pending 變成略過），再決定要不要只補寄真的沒收到的人。
5. **排程中的電子報**：還原後狀態是「排程中」、排程時間已過、但其實在 `T_restore` 之後已經寄出的，恢復寄送的下一次 tick 就會**整封重寄**。先取消排程。
6. **結果不明（寄送中）的寄送紀錄**：每封電子報按「對帳」（`POST /api/admin/campaigns/:id/reconcile`），查到的會標成已寄出。仍不明的不要重寄，到寄信服務後台確認。
7. **自動化序列**：還原會把報名進度（第幾步、下次寄送時間）倒回去，恢復寄送後可能重寄序列信。對照 pre-restore 匯出檔的 `enrollments`，對不上又無法確認的序列先關閉。

### 5. 恢復寄送前的檢查

- [ ] 第 3 步報告的「缺少」都是 0。
- [ ] 第 4 步的退訂、檢舉、退信都補了；抽幾位 `T_restore` 之後退訂的人，後台狀態是已退訂。
- [ ] 沒有「排程時間已過、但其實寄過」的排程中電子報。
- [ ] 所有寄送中的電子報都對帳過；還有 pending 的，確認過寄信服務沒有寄過。
- [ ] 序列報名進度確認過，或對不上的序列已關閉。
- [ ] `/health` 正常；操作紀錄看得到這次還原。

全部打勾後把 `SEND_PAUSED` 改回 `false` 並重新部署，記下 `T_resume`。

## 演練與 RTO／RPO

- **RPO**（能接受丟多少資料）：還原點 `T_restore` 到事故 `T_incident` 之間的時間，加上第 4 步補完後**仍然找不回來**的資料（退訂、寄送紀錄的筆數）。後者才是真正的損失。
- **RTO**（多久恢復）：`T_start` 到 `T_resume`。每一步分開計時，才知道慢在哪裡（通常是第 4 步的人工對帳）。

演練只能在測試專案或 backend branch 上做，不能用正式專案：

1. 放入合成名單（或去識別化資料），記下每張表的筆數。
2. 兩種備份都做一份，記 `T_restore`。
3. 製造還原點之後的變化：新訂閱、退訂、退信 webhook、寄一封電子報給測試信箱、留一筆結果不明的寄送紀錄。記 `T_incident`。
4. 清空 `nk_*` 資料表（或從專案備份倒回）。
5. 照上面的還原程序第 1–5 步做，每一步記開始與結束時間。
6. 把結果填進演練紀錄：

| 項目 | 結果 |
| --- | --- |
| `T_restore`／`T_incident`／`T_start`／`T_resume` | |
| RPO（時間）：`T_incident − T_restore` | |
| RPO（資料）：補完後仍缺少的退訂／寄送紀錄筆數 | |
| RTO：`T_resume − T_start` | |
| 各步驟耗時 | |
| 遇到的問題與修正 | |

### 目前的演練結果

- **本機自動化演練**（`npx vitest run test/restore-drill.test.ts`，PGlite）：合成資料約 3,300 列（1,500 位訂閱者，含退訂、退信、檢舉與名單外退訂的排除名單；已寄出、失敗、略過、pending 與結果不明的寄送紀錄；追蹤事件；自動化；操作紀錄）。匯出 → 清空 → 還原 → 核對在開發機上量到 0.2–1.4 秒（2026-11-20，幾次執行之間的差異來自 PGlite 冷啟動）；筆數、退訂與排除名單、寄送紀錄都保留，第二次還原不會多出資料。這只證明腳本邏輯：沒有網路延遲、沒有 InsForge 的速率限制，也沒有人工步驟，**不能當成正式環境的 RTO**。
- **對真的 InsForge 專案：還沒有演練過。**

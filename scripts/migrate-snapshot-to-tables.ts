/**
 * 一次性搬移：nk_snapshots（整份一列 JSON）→ 逐表（STORE_DRIVER=insforge-tables）。
 *
 * 預設只檢查、不寫入。加 --apply 才寫入；只新增、不覆寫、不刪除，可以重跑。
 * 不碰 nk_snapshots。輸出只有筆數，不印 email 或 id。
 *
 * 用法（INSFORGE_URL／INSFORGE_API_KEY 指向要搬的專案）：
 *   npx tsx scripts/migrate-snapshot-to-tables.ts --target-host <INSFORGE_URL 的主機名稱>
 *   npx tsx scripts/migrate-snapshot-to-tables.ts --target-host <主機名稱> --apply
 *   npx tsx scripts/migrate-snapshot-to-tables.ts --target-host <主機名稱> --source-file payload.json --apply
 *   npx tsx scripts/migrate-snapshot-to-tables.ts --target-host <主機名稱> --export tables-backup.json
 *
 * 參數：
 *   --target-host  必填。必須等於 INSFORGE_URL 的主機名稱，避免對錯專案執行。
 *   --apply        寫入新表（沒有這個參數就只檢查與核對）。
 *   --overwrite    主鍵已存在的列用快照覆寫。只能在切換 STORE_DRIVER 之前用。
 *   --source-file  改從 JSON 檔讀快照（nk_snapshots 的 payload），不讀 InsForge。
 *   --export       把新表整份匯出成快照格式的 JSON 檔（回退用；不寫入 InsForge）。
 *
 * 結束碼：0 正常；1 有問題（檢查沒過、核對有缺漏）；2 參數錯誤。
 */
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { createInsForgeBackend, requireCreds } from '../src/core/insforge.js';
import { createInsForgeTableDb } from '../src/core/insforge-table-db.js';
import { exportTablesToSnapshot, migrateSnapshot, type TableReport } from '../src/store/snapshot-to-tables.js';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : undefined;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

function fail(message: string, code = 2): never {
  console.error(message);
  process.exit(code);
}

function printTables(tables: Record<string, TableReport>): void {
  console.table(
    Object.fromEntries(
      Object.entries(tables).map(([name, r]) => [
        name,
        { 快照: r.snapshot, 新表: r.table, 缺少: r.missing, 新表多出: r.extra, 內容不同: r.changed },
      ]),
    ),
  );
}

async function main(): Promise<void> {
  const creds = requireCreds();
  const host = new URL(creds.url).host;
  const targetHost = arg('target-host');
  if (!targetHost) fail('必須加 --target-host <主機名稱>（INSFORGE_URL 的主機），確認要操作的專案。');
  if (targetHost !== host) fail(`--target-host（${targetHost}）與 INSFORGE_URL 的主機（${host}）不同，停止。`);
  const db = createInsForgeTableDb(creds);

  const exportPath = arg('export');
  if (exportPath) {
    const snapshot = await exportTablesToSnapshot(db);
    writeFileSync(exportPath, JSON.stringify(snapshot));
    chmodSync(exportPath, 0o600);
    console.log(`已把新表匯出到 ${exportPath}（權限 600）。`);
    return;
  }

  const sourceFile = arg('source-file');
  let snapshot: unknown;
  if (sourceFile) {
    snapshot = JSON.parse(readFileSync(sourceFile, 'utf8'));
  } else {
    snapshot = await createInsForgeBackend().loadSnapshot();
    if (!snapshot) fail('nk_snapshots 的 default 列讀到空值，停止（不會寫入任何東西）。', 1);
  }
  const { __nk_version: _version, __nk_tombstones: _tombstones, ...pure } = snapshot as Record<string, unknown>;

  const apply = flag('apply');
  const report = await migrateSnapshot(db, pure, { apply, overwrite: flag('overwrite') });
  console.log(`專案主機：${host}`);
  console.log(apply ? (report.applied ? '模式：已寫入' : '模式：檢查沒過，沒有寫入') : '模式：只檢查（加 --apply 才寫入）');
  if (report.problems.length > 0) {
    console.log('檢查發現問題：');
    for (const problem of report.problems) console.log(`- ${problem}`);
  }
  printTables(report.tables);
  if (report.unsubscribesSynced > 0) console.log(`已從快照同步退訂／退信狀態：${report.unsubscribesSynced} 筆`);

  const missing = Object.values(report.tables).reduce((sum, r) => sum + r.missing, 0);
  if (report.problems.length > 0 || (report.applied && missing > 0)) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(`搬移失敗：${(error as Error).message}`);
  process.exit(1);
});

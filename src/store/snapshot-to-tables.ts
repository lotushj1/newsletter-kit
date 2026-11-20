import { isDeepStrictEqual } from 'node:util';
import type { MemorySnapshot } from './memory-store.js';
import { assertSnapshotShape } from './snapshot-guard.js';
import { MAX_ROWS_PER_REQUEST, chunk, selectAllBySeq, type TableDb } from './table-db.js';
import { SETTINGS_TABLE, SPECS, fromRow, toRow, type EntitySpec, type Row } from './table-mapping.js';
import type { Campaign, Subscriber } from './types.js';

/**
 * nk_snapshots（整份一列 JSON）→ 逐表的一次性搬移。
 *
 * - 只新增：預設主鍵已存在的列略過，不覆寫、不刪除任何東西，可以重跑。
 *   overwrite 只在切換 driver 之前使用（那時新表還沒有人寫）。
 * - 重跑時唯一會改既有列的情況：快照裡已退訂／退信的人，在新表仍是訂閱中或待確認，
 *   就把新表改成退訂（只往「不寄」的方向同步，切換期間退訂的人不會漏掉）。
 * - 不碰 nk_snapshots；報告只有筆數，不含 email 或 id。
 */

type CollectionKey = keyof typeof SPECS;

/** 寫入順序：寄送紀錄、事件依快照陣列順序寫入，讀回的順序跟原本一樣。 */
export const COLLECTIONS: CollectionKey[] = [
  'folders',
  'subscribers',
  'campaigns',
  'deliveries',
  'events',
  'sequences',
  'sequenceSteps',
  'enrollments',
  'templates',
  'campaignStarters',
];

const REQUIRED: Record<CollectionKey, string[]> = {
  subscribers: ['id', 'email', 'status', 'createdAt'],
  campaigns: ['id', 'slug', 'status', 'createdAt', 'updatedAt'],
  deliveries: ['id', 'campaignId', 'subscriberId', 'email', 'status'],
  events: ['id', 'campaignId', 'type', 'createdAt'],
  sequences: ['id', 'name', 'trigger', 'createdAt', 'updatedAt'],
  sequenceSteps: ['id', 'sequenceId', 'position', 'campaignId'],
  enrollments: ['id', 'sequenceId', 'subscriberId', 'nextRunAt', 'status', 'createdAt'],
  folders: ['id', 'name', 'createdAt'],
  templates: ['id', 'name', 'createdAt', 'updatedAt'],
  campaignStarters: ['id', 'name', 'createdAt', 'updatedAt'],
};

const WRITE_CHUNK = MAX_ROWS_PER_REQUEST;

function items(snapshot: MemorySnapshot, key: CollectionKey): Record<string, unknown>[] {
  return ((snapshot as unknown as Record<string, unknown>)[key] as Record<string, unknown>[] | undefined) ?? [];
}

function countDuplicates(values: string[]): number {
  const seen = new Set<string>();
  let dupes = 0;
  for (const value of values) {
    if (seen.has(value)) dupes += 1;
    else seen.add(value);
  }
  return dupes;
}

/** 寫入前檢查：有任何問題就不寫（報告只列筆數）。 */
export function preflight(snapshot: unknown): string[] {
  assertSnapshotShape(snapshot, '搬移前檢查');
  const problems: string[] = [];
  for (const key of COLLECTIONS) {
    const list = items(snapshot, key);
    const dupes = countDuplicates(list.map((item) => String(item.id)));
    if (dupes > 0) problems.push(`${key}：有 ${dupes} 筆重複的 id`);
    const missing = list.filter((item) =>
      REQUIRED[key].some((field) => item[field] === undefined || item[field] === null || item[field] === ''),
    ).length;
    if (missing > 0) problems.push(`${key}：有 ${missing} 筆缺少必要欄位（${REQUIRED[key].join('、')}）`);
  }
  const emails = countDuplicates(
    items(snapshot, 'subscribers').map((s) => String(s.email ?? '').toLowerCase()),
  );
  if (emails > 0) problems.push(`subscribers：有 ${emails} 筆 email（不分大小寫）重複`);
  const slugs = countDuplicates(items(snapshot, 'campaigns').map((c) => String(c.slug ?? '')));
  if (slugs > 0) problems.push(`campaigns：有 ${slugs} 筆 slug 重複`);
  const pairs = countDuplicates(
    items(snapshot, 'enrollments').map((e) => `${String(e.sequenceId)}\u0000${String(e.subscriberId)}`),
  );
  if (pairs > 0) problems.push(`enrollments：有 ${pairs} 筆同一人重複報名同一序列`);
  const settings = (snapshot as MemorySnapshot).settings ?? {};
  const badSettings = Object.values(settings).filter((v) => typeof v !== 'string').length;
  if (badSettings > 0) problems.push(`settings：有 ${badSettings} 筆值不是字串`);
  return problems;
}

export interface TableReport {
  /** 快照裡的筆數。 */
  snapshot: number;
  /** 新表在搬移後的筆數。 */
  table: number;
  /** 快照有、新表沒有。 */
  missing: number;
  /** 新表有、快照沒有（搬移後才新增的資料）。 */
  extra: number;
  /** 兩邊都有但內容不同（搬移後有人改過，或對照有誤）。 */
  changed: number;
}

export interface MigrationReport {
  applied: boolean;
  problems: string[];
  tables: Record<string, TableReport>;
  /** 從快照同步過去的退訂筆數。 */
  unsubscribesSynced: number;
}

async function readKeys(db: TableDb, spec: EntitySpec): Promise<Map<string, Row>> {
  const rows = await selectAllBySeq<Row>(db, spec.table);
  return new Map(rows.map((row) => [String(row[spec.key]), row]));
}

async function readSettings(db: TableDb): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let offset = 0; ; offset += MAX_ROWS_PER_REQUEST) {
    const rows = await db.select<{ key: string; value: string }>(SETTINGS_TABLE, {
      order: [{ col: 'key', ascending: true }],
      limit: MAX_ROWS_PER_REQUEST,
      offset,
    });
    for (const row of rows) out.set(row.key, row.value);
    if (rows.length < MAX_ROWS_PER_REQUEST) break;
  }
  return out;
}

/** 只比對我們寫入的欄位（略過 seq 與產生欄位）。 */
function sameRow(expected: Row, actual: Row): boolean {
  for (const [column, value] of Object.entries(expected)) {
    if (!isDeepStrictEqual(actual[column] ?? null, value ?? null)) return false;
  }
  return true;
}

const STRICT_STATUSES = new Set(['unsubscribed', 'bounced']);

/** 搬移後（或單獨）核對快照與新表：筆數、缺漏、多出、內容不同。 */
export async function verifyMigration(db: TableDb, snapshot: MemorySnapshot): Promise<Record<string, TableReport>> {
  const tables: Record<string, TableReport> = {};
  for (const key of COLLECTIONS) {
    const spec = SPECS[key];
    const existing = await readKeys(db, spec);
    const list = items(snapshot, key);
    const ids = new Set(list.map((item) => String(item.id)));
    let missing = 0;
    let changed = 0;
    for (const item of list) {
      const row = existing.get(String(item.id));
      if (!row) missing += 1;
      else if (!sameRow(toRow(spec, item), row)) changed += 1;
    }
    let extra = 0;
    for (const id of existing.keys()) if (!ids.has(id)) extra += 1;
    tables[key] = { snapshot: list.length, table: existing.size, missing, extra, changed };
  }
  const settings = await readSettings(db);
  const snapshotSettings = Object.entries(snapshot.settings ?? {});
  tables.settings = {
    snapshot: snapshotSettings.length,
    table: settings.size,
    missing: snapshotSettings.filter(([k]) => !settings.has(k)).length,
    extra: [...settings.keys()].filter((k) => !(k in (snapshot.settings ?? {}))).length,
    changed: snapshotSettings.filter(([k, v]) => settings.has(k) && settings.get(k) !== v).length,
  };
  return tables;
}

/**
 * 把快照寫進新表。apply=false 只做檢查與核對（不寫入）。
 * 有 preflight 問題時一律不寫，回報問題。
 */
export async function migrateSnapshot(
  db: TableDb,
  snapshot: unknown,
  options: { apply: boolean; overwrite?: boolean },
): Promise<MigrationReport> {
  const problems = preflight(snapshot);
  const data = snapshot as MemorySnapshot;
  if (problems.length > 0 || !options.apply) {
    return { applied: false, problems, tables: await verifyMigration(db, data), unsubscribesSynced: 0 };
  }

  for (const key of COLLECTIONS) {
    const spec = SPECS[key];
    const rows = items(data, key).map((item) => toRow(spec, item));
    for (const part of chunk(rows, WRITE_CHUNK)) {
      await db.upsert(spec.table, part, { onConflict: spec.key, ignoreDuplicates: !options.overwrite });
    }
  }
  const settingRows = Object.entries(data.settings ?? {}).map(([key, value]) => ({ key, value }));
  for (const part of chunk(settingRows, WRITE_CHUNK)) {
    await db.upsert(SETTINGS_TABLE, part, { onConflict: 'key', ignoreDuplicates: !options.overwrite });
  }

  const unsubscribesSynced = await syncUnsubscribes(db, data.subscribers);
  return { applied: true, problems, tables: await verifyMigration(db, data), unsubscribesSynced };
}

/** 快照已退訂／退信、新表仍可寄的人：改成快照的狀態（只往不寄的方向）。 */
async function syncUnsubscribes(db: TableDb, subscribers: Subscriber[]): Promise<number> {
  const strict = subscribers.filter((s) => STRICT_STATUSES.has(s.status));
  if (strict.length === 0) return 0;
  const existing = await readKeys(db, SPECS.subscribers);
  let synced = 0;
  for (const subscriber of strict) {
    const row = existing.get(subscriber.id);
    if (!row || STRICT_STATUSES.has(String(row.status))) continue;
    await db.update(
      SPECS.subscribers.table,
      { status: subscriber.status, unsubscribed_at: subscriber.unsubscribedAt ?? row.unsubscribed_at ?? null },
      [{ col: 'id', op: 'eq', value: subscriber.id }],
    );
    synced += 1;
  }
  return synced;
}

/** 回退用：把新表整份讀成快照格式（寫成檔案，由人決定要不要放回 nk_snapshots）。 */
export async function exportTablesToSnapshot(db: TableDb): Promise<MemorySnapshot> {
  const read = async <T>(key: CollectionKey): Promise<T[]> =>
    (await selectAllBySeq<Row>(db, SPECS[key].table)).map((row) => fromRow<T>(SPECS[key], row));
  const campaigns = await read<Campaign>('campaigns');
  return {
    subscribers: await read('subscribers'),
    campaigns: campaigns.map((campaign) => ({
      ...campaign,
      // 統計由寄送紀錄即時計算；放空值讓舊 driver 讀得進去，讀取時會重算。
      stats: { total: 0, sent: 0, failed: 0 },
      tracking: { opens: 0, uniqueOpens: 0, clicks: 0, uniqueClicks: 0, unsubscribes: 0 },
    })),
    deliveries: await read('deliveries'),
    events: await read('events'),
    sequences: await read('sequences'),
    sequenceSteps: await read('sequenceSteps'),
    enrollments: await read('enrollments'),
    folders: await read('folders'),
    templates: await read('templates'),
    settings: Object.fromEntries(await readSettings(db)),
    campaignStarters: await read('campaignStarters'),
  };
}

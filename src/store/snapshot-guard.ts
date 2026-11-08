import type { MemorySnapshot } from './memory-store.js';

/**
 * 整包快照的完整性檢查（見 docs/data-safety.md）。
 *
 * 那次事故是遠端快照被寫成幾乎全空，之後其他實例做三方合併時，把
 * 「遠端不見了」當成「遠端刪除」，於是名單、電子報、設定被一起刪掉。
 * 這裡的規則：遠端相對上次同步的狀態大量消失、而且不是本地或有標記的
 * 批次刪除造成的，就視為遠端損毀——不合併、不寫入、讓呼叫端停下來。
 */

export class SnapshotIntegrityError extends Error {
  override readonly name = 'SnapshotIntegrityError';
  constructor(
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** 遠端資料列的寫入衝突（版本號已被別人推進），呼叫端要重讀再合併。 */
export class SnapshotConflictError extends Error {
  override readonly name = 'SnapshotConflictError';
}

const GUARDED = [
  'subscribers',
  'campaigns',
  'deliveries',
  'folders',
  'templates',
  'sequences',
  'sequenceSteps',
  'enrollments',
  'campaignStarters',
] as const;

type GuardedKey = (typeof GUARDED)[number];

/** 少於這個數量的集合不檢查（刪掉兩三個資料夾是正常操作）。 */
const MIN_BASE = 5;
/** 遠端一次少掉這個比例以上就當成異常。 */
const LOSS_RATIO = 0.5;

export interface CollectionLoss {
  collection: GuardedKey | 'settings';
  base: number;
  missing: number;
}

const idsOf = (items: { id: string }[] | undefined): Set<string> =>
  new Set((items ?? []).map((item) => item.id));

function isSuspicious(base: number, missing: number): boolean {
  return base >= MIN_BASE && missing >= Math.ceil(base * LOSS_RATIO);
}

/** 每個集合最近被刪除的 id 與刪除時的版本號：[id, version]。 */
export type Tombstones = Partial<Record<GuardedKey | 'settings', [string, number][]>>;

/** 每個集合最多保留幾筆墓碑。 */
const TOMBSTONE_KEEP = 5000;

function tombstoned(tombstones: Tombstones | undefined, key: GuardedKey | 'settings', sinceVersion: number): Set<string> {
  return new Set((tombstones?.[key] ?? []).filter(([, version]) => version > sinceVersion).map(([id]) => id));
}

/**
 * 找出「base 有、local 也還有，但 remote 不見了」的大量消失。
 * - local 自己刪掉的不算（那是本地的刪除）。
 * - remote 帶有墓碑（別的實例在 sinceVersion 之後刪掉）的不算。
 * - 所屬電子報已不在遠端的寄送紀錄不算（刪電子報會連帶刪寄送紀錄）。
 */
export function detectRemoteLoss(
  base: MemorySnapshot,
  local: MemorySnapshot,
  remote: MemorySnapshot,
  options: { tombstones?: Tombstones | undefined; sinceVersion?: number } = {},
): CollectionLoss[] {
  const sinceVersion = options.sinceVersion ?? 0;
  const losses: CollectionLoss[] = [];
  const remoteCampaigns = idsOf(remote.campaigns);
  for (const key of GUARDED) {
    const baseItems = (base[key] ?? []) as { id: string; campaignId?: string }[];
    if (baseItems.length < MIN_BASE) continue;
    const localIds = idsOf(local[key] as { id: string }[]);
    const remoteIds = idsOf(remote[key] as { id: string }[]);
    const deletedElsewhere = tombstoned(options.tombstones, key, sinceVersion);
    let missing = 0;
    for (const item of baseItems) {
      if (!localIds.has(item.id) || remoteIds.has(item.id) || deletedElsewhere.has(item.id)) continue;
      if (key === 'deliveries' && item.campaignId && !remoteCampaigns.has(item.campaignId)) continue;
      missing += 1;
    }
    if (isSuspicious(baseItems.length, missing)) {
      losses.push({ collection: key, base: baseItems.length, missing });
    }
  }
  const baseSettings = Object.keys(base.settings ?? {});
  if (baseSettings.length >= MIN_BASE) {
    const localSettings = local.settings ?? {};
    const remoteSettings = remote.settings ?? {};
    const deletedElsewhere = tombstoned(options.tombstones, 'settings', sinceVersion);
    const missing = baseSettings.filter(
      (k) => k in localSettings && !(k in remoteSettings) && !deletedElsewhere.has(k),
    ).length;
    if (isSuspicious(baseSettings.length, missing)) {
      losses.push({ collection: 'settings', base: baseSettings.length, missing });
    }
  }
  return losses;
}

/** 這次寫入刪掉的 id，記成墓碑併進既有墓碑（每個集合只留最近 TOMBSTONE_KEEP 筆）。 */
export function recordDeletions(
  previous: Tombstones | undefined,
  before: MemorySnapshot,
  after: MemorySnapshot,
  version: number,
): Tombstones {
  const next: Tombstones = {};
  const add = (key: GuardedKey | 'settings', removed: string[]) => {
    const merged = [...(previous?.[key] ?? []), ...removed.map((id) => [id, version] as [string, number])];
    if (merged.length > 0) next[key] = merged.slice(-TOMBSTONE_KEEP);
  };
  for (const key of GUARDED) {
    const afterIds = idsOf(after[key] as { id: string }[]);
    const removed = ((before[key] ?? []) as { id: string }[])
      .map((item) => item.id)
      .filter((id) => !afterIds.has(id));
    add(key, removed);
  }
  const afterSettings = after.settings ?? {};
  add(
    'settings',
    Object.keys(before.settings ?? {}).filter((k) => !(k in afterSettings)),
  );
  return next;
}

/** 快照的基本形狀；讀回來的東西不是這個樣子就不要採用。 */
export function assertSnapshotShape(value: unknown, where: string): asserts value is MemorySnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SnapshotIntegrityError(`${where}：InsForge 回傳的快照不是物件`, { where });
  }
  const snapshot = value as Record<string, unknown>;
  for (const key of ['subscribers', 'campaigns', 'deliveries'] as const) {
    if (!Array.isArray(snapshot[key])) {
      throw new SnapshotIntegrityError(`${where}：快照缺少 ${key} 陣列`, { where, key });
    }
  }
  for (const key of GUARDED) {
    if (snapshot[key] !== undefined && !Array.isArray(snapshot[key])) {
      throw new SnapshotIntegrityError(`${where}：快照的 ${key} 不是陣列`, { where, key });
    }
  }
  if (snapshot.settings !== undefined && (typeof snapshot.settings !== 'object' || snapshot.settings === null)) {
    throw new SnapshotIntegrityError(`${where}：快照的 settings 格式不正確`, { where });
  }
}

export function snapshotCounts(snapshot: MemorySnapshot): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const key of GUARDED) counts[key] = (snapshot[key] ?? []).length;
  counts.settings = Object.keys(snapshot.settings ?? {}).length;
  return counts;
}

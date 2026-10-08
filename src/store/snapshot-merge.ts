import type { MemorySnapshot } from './memory-store.js';

/**
 * 整包快照的三方合併（base＝上次同步的狀態、local＝這個程序的記憶體、remote＝遠端最新）。
 *
 * InsForge store 把全部資料存成一列 JSON；serverless 上會有多個實例同時讀寫，
 * 「整包覆寫」會讓舊實例把別人剛寫入的狀態蓋掉（例如寄送中的電子報被自動儲存
 * 蓋回草稿）。合併規則：
 * - 以 id 為單位：本地沒動的實體用遠端版本，本地新增／修改／刪除照本地。
 * - 兩邊都動到同一個實體時做欄位級合併：本地沒改的欄位用遠端的值，
 *   所以自動儲存只會帶走內文欄位，不會蓋掉遠端更新的 status／stats。
 */

interface Entity {
  id: string;
}

const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function mergeEntity<T extends Entity>(base: T, local: T, remote: T): T {
  const result: Record<string, unknown> = { ...(remote as Record<string, unknown>) };
  const keys = new Set([...Object.keys(base), ...Object.keys(local)]);
  for (const key of keys) {
    const baseValue = (base as Record<string, unknown>)[key];
    const localValue = (local as Record<string, unknown>)[key];
    if (eq(baseValue, localValue)) continue; // 本地沒改這個欄位 → 用遠端
    if (key in local) result[key] = localValue;
    else delete result[key];
  }
  return result as T;
}

function mergeCollection<T extends Entity>(base: T[], local: T[], remote: T[]): T[] {
  const result = new Map(remote.map((item) => [item.id, item] as const));
  const baseMap = new Map(base.map((item) => [item.id, item] as const));
  const localIds = new Set(local.map((item) => item.id));

  for (const item of local) {
    const before = baseMap.get(item.id);
    if (!before) {
      result.set(item.id, item); // 本地新增
      continue;
    }
    if (eq(before, item)) continue; // 本地沒動 → 保留遠端（可能被別人更新或刪除）
    const theirs = result.get(item.id);
    if (!theirs || eq(theirs, before)) {
      result.set(item.id, item); // 遠端沒動（或已刪）→ 用本地
      continue;
    }
    result.set(item.id, mergeEntity(before, item, theirs)); // 兩邊都動 → 欄位級合併
  }

  for (const id of baseMap.keys()) {
    if (!localIds.has(id)) result.delete(id); // 本地刪除
  }
  return [...result.values()];
}

function mergeSettings(
  base: Record<string, string>,
  local: Record<string, string>,
  remote: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = { ...remote };
  const keys = new Set([...Object.keys(base), ...Object.keys(local)]);
  for (const key of keys) {
    if (base[key] === local[key]) continue; // 本地沒動 → 用遠端
    if (key in local) result[key] = local[key]!;
    else delete result[key];
  }
  return result;
}

export function mergeSnapshots(
  base: MemorySnapshot,
  local: MemorySnapshot,
  remote: MemorySnapshot,
): MemorySnapshot {
  return {
    subscribers: mergeCollection(base.subscribers, local.subscribers, remote.subscribers),
    campaigns: mergeCollection(base.campaigns, local.campaigns, remote.campaigns),
    deliveries: mergeCollection(base.deliveries, local.deliveries, remote.deliveries),
    events: mergeCollection(base.events ?? [], local.events ?? [], remote.events ?? []),
    sequences: mergeCollection(base.sequences ?? [], local.sequences ?? [], remote.sequences ?? []),
    sequenceSteps: mergeCollection(
      base.sequenceSteps ?? [],
      local.sequenceSteps ?? [],
      remote.sequenceSteps ?? [],
    ),
    enrollments: mergeCollection(base.enrollments ?? [], local.enrollments ?? [], remote.enrollments ?? []),
    folders: mergeCollection(base.folders ?? [], local.folders ?? [], remote.folders ?? []),
    templates: mergeCollection(base.templates ?? [], local.templates ?? [], remote.templates ?? []),
    settings: mergeSettings(base.settings ?? {}, local.settings ?? {}, remote.settings ?? {}),
    campaignStarters: mergeCollection(
      base.campaignStarters ?? [],
      local.campaignStarters ?? [],
      remote.campaignStarters ?? [],
    ),
  };
}

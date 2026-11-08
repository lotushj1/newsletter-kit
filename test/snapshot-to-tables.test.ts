import { afterEach, describe, expect, it } from 'vitest';
import { InsForgeTableStore } from '../src/store/insforge-table-store.js';
import { MemoryStore, type MemorySnapshot } from '../src/store/memory-store.js';
import { exportTablesToSnapshot, migrateSnapshot, preflight } from '../src/store/snapshot-to-tables.js';
import type { Store } from '../src/store/types.js';
import { EMPTY_TRACKING } from '../src/store/types.js';
import { PgliteTableDb } from './support/pglite-table-db.js';

const T0 = '2026-11-01T00:00:00.000Z';
const at = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();

const opened: PgliteTableDb[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((db) => db.close()));
});
async function freshDb(): Promise<PgliteTableDb> {
  const db = await PgliteTableDb.create();
  opened.push(db);
  return db;
}

/** 形狀跟正式 nk_snapshots 的 payload 一樣（含舊資料常見的缺欄位、空字串資料夾、未知欄位）。 */
function sampleSnapshot(): MemorySnapshot {
  const subscribers = Array.from({ length: 30 }, (_, i) => ({
    id: `sub_${i}`,
    email: `user${i}@example.test`,
    name: i % 2 ? `User ${i}` : undefined,
    status: (i < 25 ? 'subscribed' : i < 28 ? 'unsubscribed' : 'pending') as 'subscribed' | 'unsubscribed' | 'pending',
    tags: i % 3 === 0 ? ['vip'] : [],
    folderId: i % 5 === 0 ? 'fld_1' : i % 5 === 1 ? '' : undefined,
    createdAt: at(i),
    unsubscribedAt: i >= 25 && i < 28 ? at(100 + i) : undefined,
    meta: i === 3 ? { suppressedReason: 'bounce' } : undefined,
  }));
  const deliveries = subscribers.slice(0, 25).map((s, i) => ({
    id: `dlv_${i}`,
    campaignId: 'cmp_1',
    subscriberId: s.id,
    email: s.email,
    status: (i % 6 === 0 ? 'failed' : 'sent') as 'failed' | 'sent',
    attempts: 1,
    sentAt: at(50),
    providerMessageId: `msg_${i}`,
  }));
  return {
    subscribers,
    campaigns: [
      {
        id: 'cmp_1',
        title: '第一期',
        slug: 'issue-1',
        subject: '第一期主旨',
        bodyMarkdown: '',
        bodyHtml: '<p>hi</p>',
        status: 'sent',
        audienceTags: [],
        audienceFolderId: '',
        sentAt: at(50),
        stats: { total: 25, sent: 20, failed: 5 },
        tracking: EMPTY_TRACKING,
        createdAt: at(40),
        updatedAt: at(51),
        // 舊快照或之後版本才有的欄位：要原樣保存。
        legacyNote: '舊欄位',
      } as MemorySnapshot['campaigns'][number],
      {
        id: 'cmp_2',
        title: '草稿',
        slug: 'draft-2',
        subject: '',
        bodyMarkdown: '舊的 markdown',
        bodyHtml: undefined as unknown as string,
        status: 'draft',
        audienceTags: ['vip'],
        audienceCondition: { op: 'tag', tag: 'vip' },
        stats: { total: 0, sent: 0, failed: 0 },
        tracking: EMPTY_TRACKING,
        createdAt: at(60),
        updatedAt: at(60),
      },
    ],
    deliveries,
    events: [
      { id: 'evt_1', campaignId: 'cmp_1', subscriberId: 'sub_1', deliveryId: 'dlv_1', type: 'open', createdAt: at(52) },
      { id: 'evt_2', campaignId: 'cmp_1', subscriberId: 'sub_2', deliveryId: 'dlv_2', type: 'click', url: 'https://x.test', createdAt: at(53) },
      { id: 'evt_3', campaignId: 'cmp_1', subscriberId: 'sub_26', type: 'unsubscribe', createdAt: at(126) },
    ],
    sequences: [{ id: 'seq_1', name: '歡迎', trigger: 'subscribe', enabled: true, createdAt: at(1), updatedAt: at(1) }],
    sequenceSteps: [{ id: 'stp_1', sequenceId: 'seq_1', position: 0, delayDays: 1, campaignId: 'cmp_2' }],
    enrollments: [
      { id: 'enr_1', sequenceId: 'seq_1', subscriberId: 'sub_4', stepIndex: 0, nextRunAt: at(200), status: 'active', createdAt: at(4) },
    ],
    folders: [{ id: 'fld_1', name: '讀者', kind: 'subscribers', createdAt: at(0) }],
    templates: [{ id: 'tpl_1', name: 'Email/歡迎', html: '<p>歡迎</p>', createdAt: at(0), updatedAt: at(0) }],
    settings: { 'brand:writerName': 'Kevin', 'suppression:abc': 'bounce' },
    campaignStarters: [
      { id: 'cst_1', name: '週報', description: '', title: '週報', preheader: '', bodyHtml: '<p></p>', createdAt: at(0), updatedAt: at(0) },
    ],
  };
}

/** 把兩個 store 的主要讀取結果攤平比較。 */
async function readAll(store: Store) {
  const campaigns = (await store.listCampaigns({ limit: 100 })).items;
  return {
    subscribers: (await store.listSubscribers({ limit: 1000 })).items,
    audience: (await store.listAudience({})).map((s) => s.id),
    campaigns,
    deliveries: await store.listDeliveries('cmp_1'),
    events: await store.listTrackingEvents({}),
    sequences: await store.listSequences(),
    steps: await store.listSequenceSteps('seq_1'),
    enrollments: await store.listEnrollments('seq_1'),
    folders: await store.listFolders('subscribers'),
    templates: await store.listTemplates(),
    starters: await store.listCampaignStarters(),
    settings: [await store.getSetting('brand:writerName'), await store.getSetting('suppression:abc')],
    period: await store.periodStats({}),
  };
}

/**
 * 讀回比較時視為相同的差異：
 * - undefined 鍵 vs 沒有這個鍵；
 * - 空字串資料夾 vs 未設定（MemoryStore 都當未分類）；
 * - scheduledAt／sentAt 未設定時新 driver 回 null（跟 SqliteStore 一樣）。
 */
function normalize<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (key, v) => {
      if ((key === 'folderId' || key === 'audienceFolderId') && v === '') return undefined;
      if ((key === 'scheduledAt' || key === 'sentAt') && v === null) return undefined;
      return v;
    }),
  ) as T;
}

describe('nk_snapshots → 逐表搬移', { timeout: 60_000 }, () => {
  it('搬移後新 driver 讀到的內容跟舊 driver 讀快照的結果一樣', async () => {
    const db = await freshDb();
    const snapshot = sampleSnapshot();
    const report = await migrateSnapshot(db, structuredClone(snapshot), { apply: true });
    expect(report.problems).toEqual([]);
    expect(report.applied).toBe(true);
    for (const [name, table] of Object.entries(report.tables)) {
      expect({ name, ...table }).toMatchObject({ name, missing: 0, extra: 0, changed: 0 });
    }
    expect(report.tables.deliveries?.table).toBe(25);

    const memory = new MemoryStore();
    (memory as unknown as { loadSnapshot(s: MemorySnapshot): void }).loadSnapshot(structuredClone(snapshot));
    const tables = new InsForgeTableStore(db);
    await tables.init();
    expect(normalize(await readAll(tables))).toEqual(normalize(await readAll(memory)));
    expect(await tables.getCampaign('cmp_1')).toMatchObject({ legacyNote: '舊欄位' });
  });

  it('只檢查模式不寫入；重跑不重複也不覆寫切換後的新資料，但會補上快照裡的退訂', async () => {
    const db = await freshDb();
    const snapshot = sampleSnapshot();
    const dry = await migrateSnapshot(db, snapshot, { apply: false });
    expect(dry.applied).toBe(false);
    expect(dry.tables.subscribers).toMatchObject({ snapshot: 30, table: 0, missing: 30 });

    await migrateSnapshot(db, snapshot, { apply: true });
    const store = new InsForgeTableStore(db);
    // 切換後新表上有人改了標題、也有新訂閱者。
    await store.updateCampaign('cmp_1', { title: '切換後改過' });
    await store.createSubscriber({ id: 'sub_new', email: 'new@example.test', status: 'subscribed', tags: [], createdAt: at(300) });
    // 切換空檔裡舊 driver 又收到一個退訂、一個新事件。
    const later = structuredClone(snapshot);
    later.subscribers[10] = { ...later.subscribers[10]!, status: 'unsubscribed', unsubscribedAt: at(299) };
    later.events.push({ id: 'evt_9', campaignId: 'cmp_1', subscriberId: 'sub_10', type: 'unsubscribe', createdAt: at(299) });

    const rerun = await migrateSnapshot(db, later, { apply: true });
    expect(rerun.unsubscribesSynced).toBe(1);
    expect(rerun.tables.subscribers).toMatchObject({ table: 31, missing: 0, extra: 1 });
    expect(rerun.tables.events).toMatchObject({ table: 4, missing: 0 });
    expect(rerun.tables.campaigns).toMatchObject({ changed: 1 }); // 新表上的修改保留，只回報
    expect((await store.getCampaign('cmp_1'))?.title).toBe('切換後改過');
    expect(await store.getSubscriber('sub_10')).toMatchObject({ status: 'unsubscribed', unsubscribedAt: at(299) });
    expect((await store.listDeliveries('cmp_1')).length).toBe(25);
  });

  it('有重複 email／slug、缺必要欄位時一律不寫入', async () => {
    const db = await freshDb();
    const snapshot = sampleSnapshot();
    snapshot.subscribers.push({ ...snapshot.subscribers[0]!, id: 'sub_dup', email: 'USER0@example.test' });
    snapshot.campaigns.push({ ...snapshot.campaigns[1]!, id: 'cmp_dup' });
    snapshot.deliveries.push({ ...snapshot.deliveries[0]!, id: 'dlv_bad', email: '' });
    expect(preflight(snapshot)).toEqual([
      'deliveries：有 1 筆缺少必要欄位（id、campaignId、subscriberId、email、status）',
      'subscribers：有 1 筆 email（不分大小寫）重複',
      'campaigns：有 1 筆 slug 重複',
    ]);
    const report = await migrateSnapshot(db, snapshot, { apply: true });
    expect(report.applied).toBe(false);
    expect(report.tables.subscribers?.table).toBe(0);
    expect(() => preflight({ subscribers: null })).toThrow(/subscribers/);
  });

  it('回退用匯出：新表可以整份匯出成舊 driver 讀得進去的快照', async () => {
    const db = await freshDb();
    const snapshot = sampleSnapshot();
    await migrateSnapshot(db, snapshot, { apply: true });
    const exported = await exportTablesToSnapshot(db);
    expect(preflight(exported)).toEqual([]);
    const fromExport = new MemoryStore();
    (fromExport as unknown as { loadSnapshot(s: MemorySnapshot): void }).loadSnapshot(exported);
    const original = new MemoryStore();
    (original as unknown as { loadSnapshot(s: MemorySnapshot): void }).loadSnapshot(structuredClone(snapshot));
    expect(normalize(await readAll(fromExport))).toEqual(normalize(await readAll(original)));
  });
});

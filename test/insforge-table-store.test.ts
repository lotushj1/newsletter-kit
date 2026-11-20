import { afterEach, describe, expect, it } from 'vitest';
import { InsForgeTableStore } from '../src/store/insforge-table-store.js';
import { MemoryStore } from '../src/store/memory-store.js';
import { TableDbError, type TableDb } from '../src/store/table-db.js';
import { SPECS, toRow } from '../src/store/table-mapping.js';
import type { Campaign, Delivery, Store, Subscriber, TrackingEvent } from '../src/store/types.js';
import { EMPTY_TRACKING } from '../src/store/types.js';
import { PgliteTableDb } from './support/pglite-table-db.js';

const T0 = '2026-11-01T00:00:00.000Z';
const at = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();

const opened: PgliteTableDb[] = [];
async function freshDb(): Promise<PgliteTableDb> {
  const db = await PgliteTableDb.create();
  opened.push(db);
  return db;
}
async function freshStore(options?: { deliveryInsertChunk?: number }): Promise<{ db: PgliteTableDb; store: InsForgeTableStore }> {
  const db = await freshDb();
  const store = new InsForgeTableStore(db, options);
  await store.init();
  return { db, store };
}
afterEach(async () => {
  await Promise.all(opened.splice(0).map((db) => db.close()));
});

function subscriber(i: number, overrides: Partial<Subscriber> = {}): Subscriber {
  return {
    id: `sub_${String(i).padStart(5, '0')}`,
    email: `user${i}@example.test`,
    status: 'subscribed',
    tags: [],
    createdAt: at(i % 7),
    ...overrides,
  };
}

function campaign(id: string, overrides: Partial<Campaign> = {}): Campaign {
  return {
    id,
    title: `標題 ${id}`,
    slug: `slug-${id}`,
    subject: `主旨 ${id}`,
    bodyMarkdown: '',
    bodyHtml: '<p>hi</p>',
    status: 'draft',
    audienceTags: [],
    stats: { total: 0, sent: 0, failed: 0 },
    tracking: EMPTY_TRACKING,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

function delivery(i: number, campaignId = 'cmp_1', overrides: Partial<Delivery> = {}): Delivery {
  return {
    id: `dlv_${String(i).padStart(5, '0')}`,
    campaignId,
    subscriberId: `sub_${String(i).padStart(5, '0')}`,
    email: `user${i}@example.test`,
    status: 'pending',
    attempts: 0,
    ...overrides,
  };
}

// PGlite 第一次啟動（WASM＋套用 migration）在並行跑全套測試時可能要好幾秒。
describe('InsForgeTableStore（逐表 driver）', { timeout: 60_000 }, () => {
  it('schema 沒套用時啟動會失敗並說明要先套用 migration', async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    const empty = new PgliteTableDb(new PGlite());
    opened.push(empty);
    await expect(new InsForgeTableStore(empty).init()).rejects.toThrow(/migrations/);
  });

  it('多個寄送程序同時領取同一批寄送紀錄：每筆只會被一個程序領到', async () => {
    const { db, store } = await freshStore();
    const ids = Array.from({ length: 60 }, (_, i) => delivery(i).id);
    await store.createDeliveries(ids.map((_, i) => delivery(i)));
    await store.updateDeliveries([
      { id: ids[0]!, patch: { status: 'sent' } },
      { id: ids[1]!, patch: { status: 'failed' } },
    ]);

    // 四個獨立的 store 實例（模擬四個 serverless 實例）同時搶同一批，彼此順序打亂。
    const workers = Array.from({ length: 4 }, () => new InsForgeTableStore(db));
    const results = await Promise.all(
      workers.map((worker, w) =>
        worker.claimDeliveries(
          w % 2 === 0 ? [...ids] : [...ids].reverse(),
          { claimId: `clm_${w}`, claimedAt: at(w) },
        ),
      ),
    );

    const all = results.flat();
    expect(new Set(all).size).toBe(all.length); // 沒有任何一筆被兩個程序領到
    expect(all.sort()).toEqual(ids.slice(2).sort()); // pending 的全部被領走，sent／failed 不動

    const rows = await store.listDeliveries('cmp_1');
    for (const [w, claimed] of results.entries()) {
      for (const id of claimed) {
        const row = rows.find((r) => r.id === id)!;
        expect(row).toMatchObject({ status: 'sending', claimId: `clm_${w}`, claimedAt: at(w) });
      }
    }
    expect(rows.find((r) => r.id === ids[0])?.status).toBe('sent');
    expect(rows.find((r) => r.id === ids[1])?.status).toBe('failed');
  });

  it('同一個 claim id 重送（逾時重試）會拿回自己剛領到的，別人的領取不受影響', async () => {
    const { store } = await freshStore();
    await store.createDeliveries([delivery(1), delivery(2), delivery(3)]);
    const claim = { claimId: 'clm_a', claimedAt: at(1) };
    expect(await store.claimDeliveries(['dlv_00001', 'dlv_00002'], claim)).toEqual(['dlv_00001', 'dlv_00002']);
    // 第一次其實成功了，但回應遺失；同一個 claim id 重送要拿回同樣兩筆。
    expect(await store.claimDeliveries(['dlv_00001', 'dlv_00002'], claim)).toEqual(['dlv_00001', 'dlv_00002']);
    // 別的程序拿不到。
    expect(await store.claimDeliveries(['dlv_00001', 'dlv_00002', 'dlv_00003'], { claimId: 'clm_b', claimedAt: at(2) })).toEqual([
      'dlv_00003',
    ]);
    expect(await store.claimDeliveries([], claim)).toEqual([]);
  });

  it('批次寫回回傳實際套用筆數；同一筆出現多次依序合併；undefined 會清空欄位', async () => {
    const { db, store } = await freshStore();
    await store.createDeliveries([delivery(1, 'cmp_1', { error: '舊錯誤' }), delivery(2)]);
    await store.claimDeliveries(['dlv_00001', 'dlv_00002'], { claimId: 'clm_1', claimedAt: at(1) });
    db.calls.length = 0;

    const applied = await store.updateDeliveries([
      { id: 'dlv_00001', patch: { status: 'pending', attempts: 1, error: '暫時失敗', claimId: undefined, claimedAt: undefined } },
      { id: 'dlv_00001', patch: { error: undefined } },
      { id: 'dlv_00002', patch: { status: 'sent', sentAt: at(2), providerMessageId: 'msg_2', attempts: 1 } },
      { id: 'dlv_missing', patch: { status: 'sent' } },
    ]);

    expect(applied).toBe(3); // 不存在的那筆不算
    expect(db.calls.filter((c) => c.op === 'rpc' && c.target === 'nk_update_deliveries')).toHaveLength(1);
    const rows = await store.listDeliveries('cmp_1');
    const first = rows.find((r) => r.id === 'dlv_00001')!;
    expect(first).toMatchObject({ status: 'pending', attempts: 1 });
    expect(first.error).toBeUndefined();
    expect(first.claimId).toBeUndefined();
    expect(first.claimedAt).toBeUndefined();
    expect(rows.find((r) => r.id === 'dlv_00002')).toMatchObject({ status: 'sent', providerMessageId: 'msg_2' });
    expect(await store.findDeliveryByProviderMessageId('msg_2')).toMatchObject({ id: 'dlv_00002' });
    expect(await store.updateDeliveries([])).toBe(0);
  });

  it('寄送紀錄分段寫入中途失敗時，已寫入的段落會被清掉（不會留下一半的清單）', async () => {
    const db = await freshDb();
    let inserts = 0;
    const flaky: TableDb = {
      ...db,
      select: db.select.bind(db),
      count: db.count.bind(db),
      upsert: db.upsert.bind(db),
      update: db.update.bind(db),
      delete: db.delete.bind(db),
      rpc: db.rpc.bind(db),
      async insert(table, rows, options) {
        if (table === 'nk_deliveries' && ++inserts === 3) throw new TableDbError('模擬寫入失敗', undefined, 503);
        return db.insert(table, rows, options);
      },
    };
    const store = new InsForgeTableStore(flaky, { deliveryInsertChunk: 10 });
    await store.init();
    await expect(store.createDeliveries(Array.from({ length: 35 }, (_, i) => delivery(i)))).rejects.toThrow(/模擬寫入失敗/);
    expect(await store.listDeliveries('cmp_1')).toEqual([]);
  });

  it('超過單次上限（1000 列）的讀取會分頁讀完，順序與寫入順序相同', async () => {
    const { store } = await freshStore();
    const deliveries = Array.from({ length: 2300 }, (_, i) => delivery(2300 - i));
    await store.createDeliveries(deliveries);
    const all = await store.listDeliveries('cmp_1');
    expect(all.map((d) => d.id)).toEqual(deliveries.map((d) => d.id));
    expect(await store.listDeliveries('cmp_1', { limit: 1500 })).toHaveLength(1500);
    expect(await store.listDeliveries('cmp_1', { status: 'pending', limit: 1 })).toHaveLength(1);
    expect((await store.deliveryStats('cmp_1')).total).toBe(2300);
  });

  it('寄送對象：分頁讀完、依建立時間排序、標籤與資料夾條件跟 MemoryStore 一樣', async () => {
    const { db, store } = await freshStore();
    const memory = new MemoryStore();
    const people = Array.from({ length: 1200 }, (_, i) =>
      subscriber(i, {
        tags: i % 3 === 0 ? ['vip'] : i % 3 === 1 ? ['a,b', '中文'] : [],
        folderId: i % 4 === 0 ? 'fld_1' : i % 4 === 1 ? '' : undefined,
        status: i % 10 === 0 ? 'unsubscribed' : 'subscribed',
      }),
    );
    for (const person of people) {
      await memory.createSubscriber(person);
    }
    // 直接寫進資料表（逐筆 createSubscriber 太慢）；寫入順序與 MemoryStore 相同。
    await db.insert('nk_subscribers', people.map((p) => toRow(SPECS.subscribers, p)));
    for (const query of [{}, { tags: ['VIP'] }, { tags: ['a,b'] }, { folderId: 'fld_1' }, { folderId: 'unfiled' }]) {
      const expected = (await memory.listAudience(query)).map((s) => s.id);
      const actual = (await store.listAudience(query)).map((s) => s.id);
      expect(actual).toEqual(expected);
    }
  });

  it('未知欄位（之後新增的欄位）會原樣保存與讀回', async () => {
    const { store } = await freshStore();
    const created = await store.createCampaign(
      campaign('cmp_x', { sendPausedAt: at(5), sendPauseReason: 'time_budget' } as Partial<Campaign>),
    );
    expect(created).toMatchObject({ sendPausedAt: at(5), sendPauseReason: 'time_budget' });
    const updated = await store.updateCampaign('cmp_x', { sendPausedAt: null, title: '新標題' } as Partial<Campaign>);
    expect(updated).toMatchObject({ sendPausedAt: null, sendPauseReason: 'time_budget', title: '新標題' });
    const cleared = await store.updateCampaign('cmp_x', { sendPauseReason: undefined } as Partial<Campaign>);
    expect(cleared).not.toHaveProperty('sendPauseReason');
    expect(await store.getCampaign('cmp_x')).toMatchObject({ sendPausedAt: null, title: '新標題' });
  });

  it('重試撞到自己剛寫入的列視為成功；真的重複 email／slug 回 409', async () => {
    const { store } = await freshStore();
    const ada = subscriber(1, { email: 'ada@example.test' });
    await store.createSubscriber(ada);
    await expect(store.createSubscriber(ada)).resolves.toMatchObject({ id: ada.id }); // 同一筆重送
    await expect(store.createSubscriber({ ...ada, id: 'sub_other' })).rejects.toMatchObject({ status: 409 });
    await store.createCampaign(campaign('cmp_1'));
    await expect(store.createCampaign(campaign('cmp_2', { slug: 'slug-cmp_1' }))).rejects.toMatchObject({ status: 409 });
    await expect(store.updateCampaign('cmp_1', { slug: 'slug-cmp_1' })).resolves.toMatchObject({ id: 'cmp_1' });
  });

  it('同一人重複報名同一序列時回傳既有那筆，不會重複報名', async () => {
    const { store } = await freshStore();
    const first = await store.createEnrollment({
      id: 'enr_1', sequenceId: 'seq_1', subscriberId: 'sub_1', stepIndex: 0, nextRunAt: at(1), status: 'active', createdAt: at(0),
    });
    const second = await store.createEnrollment({ ...first, id: 'enr_2', createdAt: at(3) });
    expect(second.id).toBe('enr_1');
    expect(await store.listEnrollments('seq_1')).toHaveLength(1);
  });

  it('刪除電子報會在同一個交易刪掉它的寄送紀錄與事件；刪除不存在的回 false', async () => {
    const { store } = await freshStore();
    await store.createCampaign(campaign('cmp_1'));
    await store.createCampaign(campaign('cmp_2'));
    await store.createDeliveries([delivery(1, 'cmp_1'), delivery(2, 'cmp_2')]);
    await store.createEvent({ id: 'evt_1', campaignId: 'cmp_1', type: 'open', createdAt: at(1) });
    await store.createEvent({ id: 'evt_1', campaignId: 'cmp_1', type: 'open', createdAt: at(1) }); // 重送不重複
    expect(await store.listTrackingEvents({ campaignId: 'cmp_1' })).toHaveLength(1);
    expect(await store.deleteCampaign('cmp_1')).toBe(true);
    expect(await store.deleteCampaign('cmp_1')).toBe(false);
    expect(await store.listDeliveries('cmp_1')).toEqual([]);
    expect(await store.listTrackingEvents({ campaignId: 'cmp_1' })).toEqual([]);
    expect(await store.listDeliveries('cmp_2')).toHaveLength(1);
  });

  it('統計、計數、篩選與排序跟 MemoryStore 結果一致', async () => {
    const { store } = await freshStore();
    const memory = new MemoryStore();
    await seedBoth([memory, store]);

    const sameOn = async <T>(read: (s: Store) => Promise<T>) => expect(await read(store)).toEqual(await read(memory));
    for (const id of ['cmp_1', 'cmp_2', 'cmp_none']) {
      await sameOn((s) => s.deliveryStats(id));
      await sameOn((s) => s.campaignTrackingStats(id));
    }
    await sameOn((s) => s.periodStats({}));
    await sameOn((s) => s.periodStats({ from: at(2), to: at(40) }));
    await sameOn((s) => s.countSubscribersByStatus());
    await sameOn((s) => s.countSubscribersByFolder());
    await sameOn((s) => s.countCampaignsByFolder());
    await sameOn((s) => s.listSubscriberTags());
    await sameOn(async (s) => (await s.listSubscribers({ limit: 7, offset: 2 })).items.map((x) => x.id));
    await sameOn(async (s) => (await s.listSubscribers({ search: 'USER1' })).total);
    await sameOn(async (s) => (await s.listSubscribers({ search: '100%' })).total);
    await sameOn(async (s) => (await s.listSubscribers({ tag: 'VIP', status: 'subscribed' })).items.map((x) => x.id));
    await sameOn(async (s) => (await s.listSubscribers({ folderId: 'unfiled' })).total);
    await sameOn(async (s) => (await s.listCampaigns({ search: '主旨 CMP_2' })).items.map((c) => c.id));
    await sameOn(async (s) => (await s.listCampaigns({ from: at(10) })).items.map((c) => c.id));
    await sameOn(async (s) => (await s.listCampaigns({ folderId: 'unfiled' })).items.map((c) => c.id));
    await sameOn(async (s) => (await s.findDueCampaigns(at(60))).map((c) => c.id));
    await sameOn(async (s) => (await s.listTrackingEvents({ campaignId: 'cmp_1', type: 'open' })).map((e) => e.id));
    await sameOn(async (s) => (await s.listFolders('subscribers')).map((f) => f.name));
    await sameOn(async (s) => (await s.getCampaign('cmp_1'))?.tracking);
  });

  it('資料夾刪除會把名單與電子報改回未分類；序列步驟整批替換', async () => {
    const { store } = await freshStore();
    await store.createFolder({ id: 'fld_s', name: '名單', kind: 'subscribers', createdAt: T0 });
    await expect(store.createFolder({ id: 'fld_x', name: ' 名單 ', kind: 'subscribers', createdAt: T0 })).rejects.toMatchObject({
      status: 409,
    });
    await store.createSubscriber(subscriber(1, { folderId: 'fld_s' }));
    await store.createCampaign(campaign('cmp_1', { audienceFolderId: 'fld_s' }));
    expect(await store.deleteFolder('fld_s')).toBe(true);
    expect((await store.getSubscriber('sub_00001'))?.folderId).toBeUndefined();
    expect((await store.getCampaign('cmp_1'))?.audienceFolderId).toBeUndefined();

    const step = (id: string, position: number) => ({ id, sequenceId: 'seq_1', position, delayDays: position, campaignId: 'cmp_1' });
    await store.replaceSequenceSteps('seq_1', [step('stp_2', 2), step('stp_1', 1)]);
    await store.replaceSequenceSteps('seq_1', [step('stp_3', 1)]);
    expect((await store.listSequenceSteps('seq_1')).map((s) => s.id)).toEqual(['stp_3']);
    await store.replaceSequenceSteps('seq_1', []);
    expect(await store.listSequenceSteps('seq_1')).toEqual([]);
  });
});

/** 兩個 store 灌同一份資料（含退訂、孤兒事件、資料夾、排程）。 */
async function seedBoth(stores: Store[]): Promise<void> {
  for (const store of stores) {
    await store.createFolder({ id: 'fld_1', name: '乙', kind: 'subscribers', createdAt: T0 });
    await store.createFolder({ id: 'fld_2', name: '甲', kind: 'subscribers', createdAt: T0 });
    for (let i = 0; i < 20; i += 1) {
      await store.createSubscriber(
        subscriber(i, {
          email: i === 5 ? 'user100%@example.test' : `user${i}@example.test`,
          name: i % 2 === 0 ? `User ${i}` : undefined,
          tags: i % 3 === 0 ? ['vip', 'z'] : ['a'],
          folderId: i % 4 === 0 ? 'fld_1' : undefined,
          status: i < 3 ? 'pending' : i < 6 ? 'unsubscribed' : 'subscribed',
          confirmedAt: i >= 3 ? at(i) : undefined,
          unsubscribedAt: i >= 3 && i < 6 ? at(30 + i) : undefined,
          createdAt: at(i % 5),
        }),
      );
    }
    await store.createCampaign(campaign('cmp_1', { status: 'sent', sentAt: at(20), createdAt: at(1), folderId: 'fld_c' }));
    await store.createCampaign(campaign('cmp_2', { status: 'scheduled', scheduledAt: at(50), createdAt: at(15) }));
    await store.createCampaign(campaign('cmp_3', { status: 'scheduled', scheduledAt: at(90), createdAt: at(16) }));
    const deliveries: Delivery[] = [];
    for (let i = 0; i < 20; i += 1) {
      deliveries.push(
        delivery(i, 'cmp_1', {
          subscriberId: `sub_${String(i).padStart(5, '0')}`,
          status: i % 5 === 0 ? 'failed' : i % 7 === 0 ? 'sending' : 'sent',
          sentAt: at(20 + (i % 3)),
        }),
      );
    }
    await store.createDeliveries(deliveries);
    const events: TrackingEvent[] = [
      { id: 'evt_1', campaignId: 'cmp_1', subscriberId: 'sub_00006', deliveryId: 'dlv_00006', type: 'open', createdAt: at(25) },
      { id: 'evt_2', campaignId: 'cmp_1', subscriberId: 'sub_00006', deliveryId: 'dlv_00006', type: 'open', createdAt: at(26) },
      { id: 'evt_3', campaignId: 'cmp_1', subscriberId: 'sub_00008', deliveryId: 'dlv_00008', type: 'click', url: 'https://a.test', createdAt: at(27) },
      { id: 'evt_4', campaignId: 'cmp_1', subscriberId: 'sub_00010', deliveryId: 'dlv_00010', type: 'open', createdAt: at(28) }, // failed → 孤兒
      { id: 'evt_5', campaignId: 'cmp_1', subscriberId: 'sub_00009', deliveryId: 'dlv_gone', type: 'click', createdAt: at(29) }, // 紀錄不存在 → 孤兒
      { id: 'evt_6', campaignId: 'cmp_1', type: 'open', createdAt: at(31) }, // 沒有 deliveryId → 算
      { id: 'evt_7', campaignId: 'cmp_1', subscriberId: 'sub_00004', type: 'unsubscribe', createdAt: at(34) },
      { id: 'evt_8', campaignId: 'cmp_2', subscriberId: 'sub_00011', deliveryId: 'dlv_00011', type: 'open', createdAt: at(45) }, // 別期的紀錄 → 孤兒
    ];
    for (const event of events) await store.createEvent(event);
  }
}

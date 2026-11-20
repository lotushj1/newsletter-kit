import { afterAll, describe, expect, it } from 'vitest';
import { createInsForgeTableDb } from '../src/core/insforge-table-db.js';
import { InsForgeTableStore } from '../src/store/insforge-table-store.js';
import type { Filter, TableDb } from '../src/store/table-db.js';
import type { Delivery } from '../src/store/types.js';
import { EMPTY_TRACKING } from '../src/store/types.js';

/**
 * 打真的 InsForge（Postgres + PostgREST）的整合測試。預設略過。
 * 只能指向測試用的 backend branch／測試專案，絕不要指向正式專案：
 *
 *   NK_TABLES_REMOTE_URL=https://<測試分支>.insforge.app NK_TABLES_REMOTE_KEY=<該分支的 API key> \
 *     npx vitest run test/insforge-table-store.remote.test.ts
 *
 * 測試資料的 id／email 都帶這次執行的前綴，結束時刪除。
 */
const url = process.env.NK_TABLES_REMOTE_URL;
const apiKey = process.env.NK_TABLES_REMOTE_KEY;
const run = `rt${Date.now().toString(36)}`;
const prefixFilter = (col = 'id'): Filter => ({
  col,
  op: 'ilike',
  value: `${run.replace(/[\\%_]/g, (c) => `\\${c}`)}%`,
});

const TABLES = [
  'nk_deliveries',
  'nk_events',
  'nk_campaigns',
  'nk_subscribers',
  'nk_folders',
  'nk_sequences',
  'nk_sequence_steps',
  'nk_enrollments',
  'nk_templates',
  'nk_campaign_starters',
];

describe.skipIf(!url || !apiKey)('InsForgeTableStore 打真的 InsForge（測試分支）', { timeout: 180_000 }, () => {
  const client = (): TableDb => createInsForgeTableDb({ url: url!, apiKey: apiKey! });
  const db = url && apiKey ? client() : (null as unknown as TableDb);
  const store = new InsForgeTableStore(db);

  afterAll(async () => {
    if (!url || !apiKey) return;
    for (const table of TABLES) await db.delete(table, [prefixFilter()]);
    await db.delete('nk_settings', [prefixFilter('key')], 'key');
  });

  const delivery = (i: number, campaignId: string): Delivery => ({
    id: `${run}_dlv_${String(i).padStart(5, '0')}`,
    campaignId,
    subscriberId: `${run}_sub_${i}`,
    email: `${run}.${i}@example.test`,
    status: 'pending',
    attempts: 0,
  });

  it('schema 版本相符', async () => {
    await expect(store.init()).resolves.toBeUndefined();
  });

  it('多個獨立連線同時領取：每筆只被領一次；同 claim id 重送拿回自己的', async () => {
    const campaignId = `${run}_cmp_claim`;
    const deliveries = Array.from({ length: 300 }, (_, i) => delivery(i, campaignId));
    await store.createDeliveries(deliveries);
    const ids = deliveries.map((d) => d.id);

    // 6 個獨立 client（各自的連線），分 3 輪、每輪搶重疊的 120 筆。
    const workers = Array.from({ length: 6 }, () => new InsForgeTableStore(client()));
    const claimed: string[][] = [];
    for (let round = 0; round < 3; round += 1) {
      const slice = ids.slice(round * 90, round * 90 + 120);
      const results = await Promise.all(
        workers.map((worker, w) =>
          worker.claimDeliveries(w % 2 ? [...slice].reverse() : slice, {
            claimId: `${run}_clm_${round}_${w}`,
            claimedAt: new Date().toISOString(),
          }),
        ),
      );
      claimed.push(...results);
    }
    const all = claimed.flat();
    expect(new Set(all).size).toBe(all.length);
    expect(new Set(all)).toEqual(new Set(ids.slice(0, 300)));

    const rows = await store.listDeliveries(campaignId);
    expect(rows).toHaveLength(300);
    expect(rows.every((r) => r.status === 'sending' && r.claimId?.startsWith(`${run}_clm_`))).toBe(true);
    // 每筆的 claim id 就是回報領到它的那個程序。
    const owner = new Map<string, string>();
    claimed.forEach((list, index) => {
      const round = Math.floor(index / 6);
      for (const id of list) owner.set(id, `${run}_clm_${round}_${index % 6}`);
    });
    for (const row of rows) expect(row.claimId).toBe(owner.get(row.id));

    // 同一個 claim id 重送（模擬逾時重試）拿回同樣的列。
    const first = claimed[0]!;
    const again = await workers[0]!.claimDeliveries(ids.slice(0, 120), {
      claimId: `${run}_clm_0_0`,
      claimedAt: new Date().toISOString(),
    });
    expect(new Set(again)).toEqual(new Set(first));
  });

  it('批次寫回筆數、分頁讀取超過 1000 列、統計', async () => {
    const campaignId = `${run}_cmp_bulk`;
    const deliveries = Array.from({ length: 2100 }, (_, i) => delivery(10_000 + i, campaignId));
    await store.createDeliveries(deliveries);
    expect((await store.listDeliveries(campaignId)).map((d) => d.id)).toEqual(deliveries.map((d) => d.id));

    const updates = deliveries.slice(0, 1500).map((d, i) => ({
      id: d.id,
      patch: i % 3 === 0
        ? { status: 'failed' as const, attempts: 1, error: '退信' }
        : { status: 'sent' as const, attempts: 1, sentAt: new Date().toISOString(), providerMessageId: `${run}_msg_${i}` },
    }));
    updates.push({ id: `${run}_missing`, patch: { status: 'sent' as const, attempts: 1, sentAt: '', providerMessageId: '' } });
    expect(await store.updateDeliveries(updates)).toBe(1500);
    expect(await store.deliveryStats(campaignId)).toEqual({ total: 2100, sent: 1000, failed: 500, unconfirmed: 0 });
    expect(await store.findDeliveryByProviderMessageId(`${run}_msg_1`)).toMatchObject({ id: deliveries[1]!.id });
    expect(await store.listDeliveries(campaignId, { status: 'pending', limit: 1 })).toHaveLength(1);
  });

  it('各種實體的建立／讀取／更新／刪除與唯一鍵', async () => {
    const sub = await store.createSubscriber({
      id: `${run}_sub_a`,
      email: `${run}.A@Example.test`,
      name: '測試 100%',
      status: 'subscribed',
      tags: ['vip', 'a,b'],
      createdAt: new Date().toISOString(),
    });
    expect(await store.getSubscriberByEmail(`${run}.a@example.test`)).toMatchObject({ id: sub.id, tags: ['vip', 'a,b'] });
    await expect(
      store.createSubscriber({ ...sub, id: `${run}_sub_b`, email: `${run}.a@example.test` }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await store.listSubscribers({ search: '100%' })).items.map((s) => s.id)).toContain(sub.id);
    expect((await store.listSubscribers({ tag: 'a,b' })).items.map((s) => s.id)).toContain(sub.id);
    expect((await store.listAudience({ tags: ['A,B'] })).map((s) => s.id)).toContain(sub.id);
    expect(await store.updateSubscriber(sub.id, { status: 'unsubscribed', meta: { reason: 'x' } })).toMatchObject({
      status: 'unsubscribed',
      meta: { reason: 'x' },
    });

    const created = await store.createCampaign({
      id: `${run}_cmp_a`,
      title: '遠端測試',
      slug: `${run}-slug`,
      subject: '主旨',
      bodyMarkdown: '',
      bodyHtml: '<p>x</p>',
      status: 'draft',
      audienceTags: [],
      stats: { total: 0, sent: 0, failed: 0 },
      tracking: EMPTY_TRACKING,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      futureField: 'kept',
    } as never);
    expect(created).toMatchObject({ futureField: 'kept', stats: { total: 0 } });
    await expect(
      store.createCampaign({ ...created, id: `${run}_cmp_b` }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await store.updateCampaign(created.id, { status: 'scheduled', scheduledAt: '2000-01-01T00:00:00.000Z' })).toMatchObject({
      status: 'scheduled',
      futureField: 'kept',
    });
    expect((await store.findDueCampaigns(new Date().toISOString())).map((c) => c.id)).toContain(created.id);
    await store.createEvent({ id: `${run}_evt_1`, campaignId: created.id, type: 'open', createdAt: new Date().toISOString() });
    await store.createEvent({ id: `${run}_evt_1`, campaignId: created.id, type: 'open', createdAt: new Date().toISOString() });
    expect((await store.campaignTrackingStats(created.id)).opens).toBe(1);
    expect(await store.deleteCampaign(created.id)).toBe(true);
    expect(await store.listTrackingEvents({ campaignId: created.id })).toEqual([]);

    await store.setSetting(`${run}:k`, 'v1');
    await store.setSetting(`${run}:k`, 'v2');
    expect(await store.getSetting(`${run}:k`)).toBe('v2');

    await store.createFolder({ id: `${run}_fld`, name: `${run} 資料夾`, kind: 'subscribers', createdAt: new Date().toISOString() });
    await store.updateSubscriber(sub.id, { folderId: `${run}_fld` });
    expect(await store.deleteFolder(`${run}_fld`)).toBe(true);
    expect((await store.getSubscriber(sub.id))?.folderId).toBeUndefined();

    await store.createSequence({
      id: `${run}_seq`, name: '序列', trigger: 'subscribe', enabled: true,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    await store.replaceSequenceSteps(`${run}_seq`, [
      { id: `${run}_stp_2`, sequenceId: `${run}_seq`, position: 2, delayDays: 3, campaignId: 'x' },
      { id: `${run}_stp_1`, sequenceId: `${run}_seq`, position: 1, delayDays: 0, campaignId: 'x' },
    ]);
    expect((await store.listSequenceSteps(`${run}_seq`)).map((s) => s.position)).toEqual([1, 2]);
    const enrollment = {
      id: `${run}_enr_1`, sequenceId: `${run}_seq`, subscriberId: sub.id, stepIndex: 0,
      nextRunAt: '2000-01-01T00:00:00.000Z', status: 'active' as const, createdAt: new Date().toISOString(),
    };
    await store.createEnrollment(enrollment);
    expect((await store.createEnrollment({ ...enrollment, id: `${run}_enr_2` })).id).toBe(enrollment.id);
    expect((await store.findDueEnrollments(new Date().toISOString())).map((e) => e.id)).toContain(enrollment.id);
    expect(await store.deleteSequence(`${run}_seq`)).toBe(true);
    expect(await store.listSequenceSteps(`${run}_seq`)).toEqual([]);

    expect(await store.deleteSubscriber(sub.id)).toBe(true);
    expect(typeof (await store.periodStats({})).sent).toBe('number');
    expect((await store.countSubscribersByStatus()).subscribed).toBeGreaterThanOrEqual(0);
  });
});

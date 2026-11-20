import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it } from 'vitest';
import { selectAudience } from '../src/services/audience.js';
import type { ServiceContext } from '../src/services/context.js';
import { importSubscribersCsv, unsubscribeByEmail } from '../src/services/subscribers.js';
import { applyProviderProblem, suppressedEmails } from '../src/services/suppression.js';
import { InsForgeTableStore } from '../src/store/insforge-table-store.js';
import { exportTablesToSnapshot, migrateSnapshot } from '../src/store/snapshot-to-tables.js';
import { SETTINGS_TABLE, SPECS, toRow } from '../src/store/table-mapping.js';
import type { Delivery, DeliveryStatus, Subscriber } from '../src/store/types.js';
import { EMPTY_TRACKING } from '../src/store/types.js';
import { fakeAdapter, testConfig } from './helpers.js';
import { PgliteTableDb } from './support/pglite-table-db.js';

/**
 * 還原演練（自動化，本機 PGlite）：合成名單 → 匯出 → 清空 → 還原 → 核對 → 再還原一次。
 * 走的是 scripts/migrate-snapshot-to-tables.ts 的 --export 與 --source-file --apply 同一組函式。
 * 還沒有對真的 InsForge 專案演練過，見 docs/backup-restore.md。
 */

const T0 = Date.parse('2026-11-01T00:00:00.000Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const SUBSCRIBERS = 1_500; // 超過單次讀取 1,000 列，走到分頁
const NOT_ON_LIST = 'gone-before-restore@example.test';

const opened: PgliteTableDb[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((db) => db.close()));
});

const email = (i: number) => `reader${i}@example.test`;
const statusFor = (i: number): DeliveryStatus => (i % 50 === 0 ? 'failed' : i % 77 === 0 ? 'skipped' : 'sent');
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, k) => from + k);

async function seed(db: PgliteTableDb, ctx: ServiceContext): Promise<void> {
  const store = ctx.store;
  const subscribers: Subscriber[] = Array.from({ length: SUBSCRIBERS }, (_, i) => ({
    id: `sub_${i}`,
    email: email(i),
    status: 'subscribed',
    tags: i % 4 === 0 ? ['vip'] : [],
    source: 'import',
    createdAt: at(i % 600),
    confirmedAt: at(i % 600),
  }));
  await db.insert(SPECS.subscribers.table, subscribers.map((s) => toRow(SPECS.subscribers, s)));

  // 退訂、硬退信、檢舉都走正式的服務流程，排除名單（suppression hash）才會跟正式環境一樣。
  for (let i = 0; i < 40; i += 1) await unsubscribeByEmail(ctx, email(i));
  for (let i = 40; i < 55; i += 1) await applyProviderProblem(ctx, { email: email(i), reason: 'bounce', provider: 'drill' });
  for (let i = 55; i < 60; i += 1) await applyProviderProblem(ctx, { email: email(i), reason: 'complaint', provider: 'drill' });
  // 名單裡沒有的人按退訂：只留下排除名單的 hash。
  await unsubscribeByEmail(ctx, NOT_ON_LIST);

  const base = {
    bodyMarkdown: '',
    bodyHtml: '<p>內文</p>',
    audienceTags: [],
    stats: { total: 0, sent: 0, failed: 0 },
    tracking: EMPTY_TRACKING,
  };
  await store.createCampaign({ ...base, id: 'cmp_sent', title: '已寄出', slug: 'sent', subject: '主旨', status: 'sent', sentAt: at(700), createdAt: at(650), updatedAt: at(700) });
  await store.createCampaign({ ...base, id: 'cmp_sending', title: '寄送中斷', slug: 'sending', subject: '主旨', status: 'sending', createdAt: at(800), updatedAt: at(800) });

  const deliveries: Delivery[] = [];
  for (let i = 60; i < SUBSCRIBERS; i += 1) {
    const status = statusFor(i);
    deliveries.push({
      id: `dlv_sent_${i}`,
      campaignId: 'cmp_sent',
      subscriberId: `sub_${i}`,
      email: email(i),
      status,
      attempts: 1,
      ...(status === 'sent' ? { sentAt: at(700), providerMessageId: `msg_${i}` } : {}),
      ...(status === 'failed' ? { error: '硬退信（drill）', providerMessageId: `msg_${i}` } : {}),
    });
  }
  // 中斷的寄送：已交給寄信服務但結果不明（sending）與還沒寄（pending）都要原樣保留，還原後先對帳。
  for (let i = 60; i < 260; i += 1) {
    const unknown = i < 90;
    deliveries.push({
      id: `dlv_open_${i}`,
      campaignId: 'cmp_sending',
      subscriberId: `sub_${i}`,
      email: email(i),
      status: unknown ? 'sending' : 'pending',
      attempts: 0,
      ...(unknown ? { claimId: 'claim_drill', claimedAt: at(801) } : {}),
    });
  }
  await store.createDeliveries(deliveries);

  for (let i = 60; i < 200; i += 1) {
    await store.createEvent({ id: `evt_open_${i}`, campaignId: 'cmp_sent', subscriberId: `sub_${i}`, deliveryId: `dlv_sent_${i}`, type: 'open', createdAt: at(710) });
  }
  for (let i = 60; i < 90; i += 1) {
    await store.createEvent({ id: `evt_click_${i}`, campaignId: 'cmp_sent', subscriberId: `sub_${i}`, deliveryId: `dlv_sent_${i}`, type: 'click', url: 'https://example.test/a', createdAt: at(711) });
  }

  await store.createFolder({ id: 'fld_1', name: '讀者', kind: 'subscribers', createdAt: at(0) });
  await store.createSequence({ id: 'seq_1', name: '歡迎', trigger: 'subscribe', enabled: true, createdAt: at(0), updatedAt: at(0) });
  await store.replaceSequenceSteps('seq_1', [{ id: 'stp_1', sequenceId: 'seq_1', position: 0, delayDays: 1, campaignId: 'cmp_sent' }]);
  await store.createEnrollment({ id: 'enr_1', sequenceId: 'seq_1', subscriberId: 'sub_100', stepIndex: 1, nextRunAt: at(2000), status: 'active', createdAt: at(100) });
  await store.createTemplate({ id: 'tpl_1', name: 'Email/歡迎', html: '<p>歡迎</p>', createdAt: at(0), updatedAt: at(0) });
  await store.setSetting('brand', JSON.stringify({ writerName: '測試發行者' }));
  await store.appendAuditEntry({ id: 'aud_seed', at: at(700), actor: 'admin-token', action: 'campaign.send', targetId: 'cmp_sent', summary: '寄送佇列共 1440 筆' });
}

async function rowCounts(db: PgliteTableDb): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const [key, spec] of Object.entries(SPECS)) counts[key] = await db.count(spec.table);
  counts.settings = await db.count(SETTINGS_TABLE);
  return counts;
}

async function wipe(db: PgliteTableDb): Promise<void> {
  // 模擬資料遺失。TRUNCATE 不經過逐列 trigger，所以連操作紀錄一起清掉（真實事故也可能整個專案不見）。
  const tables = [...Object.values(SPECS).map((spec) => spec.table), SETTINGS_TABLE].map((t) => `public.${t}`);
  await db.pg.exec(`TRUNCATE ${tables.join(', ')}`);
}

const blocked = (ids: number[]) => ids.map(email);

describe('還原演練：匯出 → 清空 → 還原（PGlite）', { timeout: 120_000 }, () => {
  it('筆數、退訂與排除名單、寄送紀錄都還在；再還原一次不會多出資料', async () => {
    const db = await PgliteTableDb.create();
    opened.push(db);
    const store = new InsForgeTableStore(db);
    await store.init();
    const ctx: ServiceContext = { config: testConfig(), store, adapter: fakeAdapter(), ai: null };
    await seed(db, ctx);
    const before = await rowCounts(db);
    expect(before.subscribers).toBe(SUBSCRIBERS);

    const t0 = performance.now();
    // 匯出寫成檔案再讀回（跟 --export 寫出、--source-file 讀入一樣經過 JSON）。
    const file = JSON.stringify(await exportTablesToSnapshot(db));
    const t1 = performance.now();
    await wipe(db);
    expect(await db.count(SPECS.subscribers.table)).toBe(0);
    const t2 = performance.now();
    const report = await migrateSnapshot(db, JSON.parse(file), {
      apply: true,
      audit: { id: 'aud_restore_1', at: new Date().toISOString(), actor: 'drill' },
    });
    const t3 = performance.now();

    expect(report.problems).toEqual([]);
    expect(report.applied).toBe(true);
    for (const [table, r] of Object.entries(report.tables)) {
      expect({ table, missing: r.missing, changed: r.changed, extra: r.extra }).toEqual({ table, missing: 0, changed: 0, extra: 0 });
    }

    const after = await rowCounts(db);
    expect(after).toEqual({ ...before, auditLog: before.auditLog! + 1 });

    // 匯出內容逐筆相同（操作紀錄多了這次還原的一筆）。
    const restored = await exportTablesToSnapshot(db);
    const original = JSON.parse(file);
    expect({ ...restored, auditLog: undefined }).toEqual({ ...original, auditLog: undefined });
    expect(restored.auditLog?.map((e) => e.action)).toEqual(['campaign.send', 'data.restore']);

    // 名單狀態：退訂 40、退信 15、檢舉 5（檢舉記成退訂）。
    expect(await store.countSubscribersByStatus()).toEqual({
      pending: 0,
      subscribed: SUBSCRIBERS - 60,
      unsubscribed: 45,
      bounced: 15,
    });

    // 排除名單（hash）還在：退信、檢舉、名單外的退訂。
    const suppressed = await suppressedEmails(ctx, [...blocked(range(40, 60)), NOT_ON_LIST, email(100)]);
    expect([...suppressed].sort()).toEqual([...blocked(range(40, 60)), NOT_ON_LIST].sort());

    // 下一期的收件人不含任何退訂、退信、檢舉的人。
    const audience = new Set((await selectAudience(ctx, { audienceTags: [] })).map((s) => s.email));
    expect(audience.size).toBe(SUBSCRIBERS - 60);
    for (const address of blocked(range(0, 60))) expect(audience.has(address)).toBe(false);

    // 名單外退訂的人之後被匯入，仍然不會寄給他（要靠排除名單 hash）。
    await importSubscribersCsv(ctx, `email\n${NOT_ON_LIST}\n`);
    const afterImport = (await selectAudience(ctx, { audienceTags: [] })).map((s) => s.email);
    expect(afterImport).not.toContain(NOT_ON_LIST);

    // 寄送紀錄：已寄出、失敗、略過，以及中斷寄送的 pending／sending（結果不明）原樣保留。
    expect(await store.deliveryStats('cmp_sent')).toEqual(statsOf(original.deliveries, 'cmp_sent'));
    const open = await store.listDeliveries('cmp_sending');
    expect(open.filter((d) => d.status === 'sending')).toHaveLength(30);
    expect(open.filter((d) => d.status === 'pending')).toHaveLength(170);
    expect(open.find((d) => d.status === 'sending')).toMatchObject({ claimId: 'claim_drill', claimedAt: at(801) });
    const attributableOpens = range(60, 200).filter((i) => statusFor(i) === 'sent').length;
    expect((await store.campaignTrackingStats('cmp_sent')).uniqueOpens).toBe(attributableOpens);

    // 再還原一次：只新增、不重複，資料筆數不變（只多一筆還原紀錄）。
    const again = await migrateSnapshot(db, JSON.parse(file), {
      apply: true,
      audit: { id: 'aud_restore_2', at: new Date().toISOString(), actor: 'drill' },
    });
    expect(again.applied).toBe(true);
    const afterSecond = await rowCounts(db);
    // 剛才匯入的那一位（名單外退訂者）是還原後才新增的資料，不會被第二次還原刪掉。
    expect(afterSecond).toEqual({ ...before, subscribers: before.subscribers! + 1, auditLog: before.auditLog! + 2 });
    expect(again.tables.subscribers).toMatchObject({ missing: 0, changed: 0, extra: 1 });

    const ms = (value: number) => Math.round(value);
    console.log(
      `[restore-drill] ${Object.values(before).reduce((sum, n) => sum + n, 0)} 列：匯出 ${ms(t1 - t0)} ms、` +
        `清空 ${ms(t2 - t1)} ms、還原與核對 ${ms(t3 - t2)} ms、合計 ${ms(t3 - t0)} ms`,
    );
  });
});

function statsOf(deliveries: Delivery[], campaignId: string) {
  const mine = deliveries.filter((d) => d.campaignId === campaignId);
  return {
    total: mine.length,
    sent: mine.filter((d) => d.status === 'sent').length,
    failed: mine.filter((d) => d.status === 'failed').length,
    unconfirmed: mine.filter((d) => d.status === 'sending').length,
  };
}

import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/http/app.js';
import { AppError } from '../src/core/errors.js';
import { createCampaign, scheduleCampaign } from '../src/services/campaigns.js';
import type { ServiceContext } from '../src/services/context.js';
import { readinessReport } from '../src/services/readiness.js';
import { readSchedulerState, SCHEDULER_STATE_KEY } from '../src/services/scheduler-state.js';
import { createScheduler } from '../src/services/scheduler.js';
import { sendingBlockedReason, startCampaign } from '../src/services/sending.js';
import { checkStoreReadiness, STORE_UNAVAILABLE } from '../src/services/store-readiness.js';
import { createSubscriber, subscribe } from '../src/services/subscribers.js';
import { InsForgeTableStore } from '../src/store/insforge-table-store.js';
import { MemoryStore } from '../src/store/memory-store.js';
import { PgliteTableDb } from './support/pglite-table-db.js';
import { fakeAdapter, makeContext, testConfig } from './helpers.js';

/** setSetting／createSubscriber 可以切換成失敗的 store：模擬資料庫唯讀或連不上。 */
class ReadOnlyStore extends MemoryStore {
  readOnly = false;

  override async setSetting(key: string, value: string): Promise<void> {
    if (this.readOnly) throw new Error('模擬資料庫唯讀');
    return super.setSetting(key, value);
  }
}

async function readOnlyContext(): Promise<{ ctx: ServiceContext; store: ReadOnlyStore }> {
  const store = new ReadOnlyStore();
  await store.init();
  return {
    ctx: { config: testConfig({ scheduler: { enabled: true, pollMs: 1000, cronSecret: 's3cret' } }), store, adapter: fakeAdapter(), ai: null },
    store,
  };
}

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

const opened: PgliteTableDb[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((db) => db.close()));
});

async function tablesContext(): Promise<{ ctx: ServiceContext; db: PgliteTableDb }> {
  const db = await PgliteTableDb.create();
  opened.push(db);
  const store = new InsForgeTableStore(db);
  await store.init();
  return { ctx: { config: testConfig(), store, adapter: fakeAdapter(), ai: null }, db };
}

describe('資料層寫入檢查', () => {
  it('寫得進去：寫入探測通過，不擋寄送', async () => {
    const { ctx } = await makeContext();
    const readiness = await checkStoreReadiness(ctx);
    expect(readiness).toMatchObject({ ok: true, writable: true, problems: [] });
    expect(sendingBlockedReason(ctx)).toBeNull();
  });

  it('寫不進去：公開訂閱回 503（store_unavailable），不建立訂閱者也不寄確認信', async () => {
    const { ctx, store } = await readOnlyContext();
    store.readOnly = true;
    const error = await subscribe(ctx, { email: 'new@example.com' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).status).toBe(503);
    expect((error as AppError).code).toBe(STORE_UNAVAILABLE);
    expect(await store.getSubscriberByEmail('new@example.com')).toBeNull();
    expect((ctx.adapter as ReturnType<typeof fakeAdapter>).sent).toHaveLength(0);

    // 資料庫恢復後馬上就能訂閱（有問題的結果不快取）。
    store.readOnly = false;
    expect((await subscribe(ctx, { email: 'new@example.com' })).status).toBe('pending');
  });

  it('寫不進去：手動寄送回 503，排程 tick 也跳過寄送', async () => {
    const { ctx, store } = await readOnlyContext();
    await createSubscriber(ctx, { email: 'a@example.com' });
    const campaign = await createCampaign(ctx, { title: 't', bodyMarkdown: '嗨' });
    const due = await createCampaign(ctx, { title: 'due', bodyMarkdown: '嗨' });
    await scheduleCampaign(ctx, due.id, new Date(Date.now() - 1000).toISOString());
    store.readOnly = true;

    const error = await startCampaign(ctx, campaign.id).catch((e: unknown) => e);
    expect((error as AppError).status).toBe(503);
    expect((error as AppError).message).toMatch(/資料庫目前無法寫入，已停止寄送/);
    expect(sendingBlockedReason(ctx)).toMatch(/模擬資料庫唯讀/);

    const summary = await createScheduler(ctx).tick();
    expect(summary.skippedReason).toBe('sending_blocked');
    expect((ctx.adapter as ReturnType<typeof fakeAdapter>).sent).toHaveLength(0);
    expect((await ctx.store.getCampaign(due.id))?.status).toBe('scheduled');
  });

  it('InsForge 逐表：schema 版本不符或少了資料表時擋下寄送，運作狀態列出缺什麼', async () => {
    const { ctx, db } = await tablesContext();
    expect((await checkStoreReadiness(ctx, { full: true })).ok).toBe(true);

    await db.pg.exec('DROP TABLE public.nk_events');
    const missing = await checkStoreReadiness(ctx, { full: true });
    expect(missing.ok).toBe(false);
    expect(missing.schema?.missing).toContain('nk_events');
    // 用到 nk_events 的函式（nk_campaign_stats）也一起讀不到。
    expect(missing.problems.join()).toMatch(/缺少或讀不到：.*nk_events/);
    expect(sendingBlockedReason(ctx)).toMatch(/nk_events/);

    await db.pg.exec('CREATE OR REPLACE FUNCTION public.nk_tables_schema_version() RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 2 $$');
    const mismatch = await checkStoreReadiness(ctx);
    expect(mismatch.schema).toMatchObject({ version: 2, expectedVersion: 1 });
    expect(mismatch.problems.join()).toMatch(/資料表版本 2 與程式需要的 1 不符/);
  });
});

describe('排程 tick 紀錄', () => {
  it('記下開始、成功跑完、耗時、落後時間與剩下的待辦', async () => {
    const { ctx } = await makeContext({ scheduler: { enabled: true, pollMs: 1000, cronSecret: undefined } });
    await createSubscriber(ctx, { email: 'a@example.com' });
    const campaign = await createCampaign(ctx, { title: 't', bodyMarkdown: '嗨' });
    await scheduleCampaign(ctx, campaign.id, new Date(Date.now() - 1000).toISOString());
    await ctx.store.updateCampaign(campaign.id, { scheduledAt: minutesAgo(3) });

    const scheduler = createScheduler(ctx);
    await scheduler.tick();
    const first = await readSchedulerState(ctx);
    expect(first.lastStartedAt).not.toBeNull();
    expect(first.lastCompletedAt).not.toBeNull();
    expect(first.lastError).toBeNull();
    expect(first.lastDurationMs).toBeGreaterThanOrEqual(0);
    expect(first.lastLagMs).toBeGreaterThanOrEqual(3 * 60_000 - 1000);
    expect(first.lastIntervalMs).toBeNull();
    expect(first.backlog).toEqual({ dueCampaigns: 0, sendingCampaigns: 0 });

    await scheduler.tick();
    const second = await readSchedulerState(ctx);
    expect(second.lastIntervalMs).toBeGreaterThanOrEqual(0);
    expect(second.lastLagMs).toBe(0);
  });

  it('tick 失敗時保留上一次成功的時間，記下錯誤', async () => {
    const { ctx, store } = await makeContext({ scheduler: { enabled: true, pollMs: 1000, cronSecret: undefined } });
    const scheduler = createScheduler(ctx);
    await scheduler.tick();
    const ok = await readSchedulerState(ctx);

    const original = store.findDueCampaigns.bind(store);
    store.findDueCampaigns = async () => {
      throw new Error('讀取失敗');
    };
    const summary = await scheduler.tick();
    store.findDueCampaigns = original;
    expect(summary.error).toBe('讀取失敗');
    const failed = await readSchedulerState(ctx);
    expect(failed.lastError).toBe('讀取失敗');
    expect(failed.lastCompletedAt).toBe(ok.lastCompletedAt);
    expect(failed.lastFinishedAt).not.toBeNull();
  });

  it('記下 SEND_PAUSED 與排程關閉從什麼時候開始，解除後清空', async () => {
    const { ctx } = await makeContext({ scheduler: { enabled: false, pollMs: 1000, cronSecret: undefined } });
    ctx.config.send.paused = true;
    const scheduler = createScheduler(ctx);
    await scheduler.tick();
    const paused = await readSchedulerState(ctx);
    expect(paused.sendPausedSince).not.toBeNull();
    expect(paused.schedulerDisabledSince).not.toBeNull();

    await scheduler.tick();
    expect((await readSchedulerState(ctx)).sendPausedSince).toBe(paused.sendPausedSince);

    ctx.config.send.paused = false;
    ctx.config.scheduler.enabled = true;
    await scheduler.tick();
    const resumed = await readSchedulerState(ctx);
    expect(resumed.sendPausedSince).toBeNull();
    expect(resumed.schedulerDisabledSince).toBeNull();
  });
});

describe('運作狀態（readiness）', () => {
  it('排程開啟但從沒跑過 tick：提醒；跑過一次後就沒有提醒', async () => {
    const { ctx } = await makeContext({ scheduler: { enabled: true, pollMs: 1000, cronSecret: undefined } });
    const before = await readinessReport(ctx);
    expect(before.ready).toBe(true);
    expect(before.ok).toBe(false);
    expect(before.alerts.map((a) => a.code)).toEqual(['scheduler_never_ran']);

    await createScheduler(ctx).tick();
    const after = await readinessReport(ctx);
    expect(after.ok).toBe(true);
    expect(after.alerts).toEqual([]);
    expect(after.scheduler.lastSuccessAgeMs).toBeGreaterThanOrEqual(0);
    expect(after.sending).toMatchObject({ provider: 'fake', dryRun: false, paused: false, schedulerEnabled: true });
  });

  it('上次成功 tick 太舊、排程逾期、寄送卡住、結果未確認、暫停太久都會提醒', async () => {
    const { ctx, store } = await makeContext({ scheduler: { enabled: true, pollMs: 1000, cronSecret: undefined } });
    ctx.config.send.paused = true;
    await store.setSetting(
      SCHEDULER_STATE_KEY,
      JSON.stringify({ lastStartedAt: minutesAgo(20), lastCompletedAt: minutesAgo(20), sendPausedSince: minutesAgo(25 * 60) }),
    );
    const sub = await createSubscriber(ctx, { email: 'a@example.com' });
    const overdue = await createCampaign(ctx, { title: '逾期', bodyMarkdown: '嗨' });
    await store.updateCampaign(overdue.id, { status: 'scheduled', scheduledAt: minutesAgo(20) });
    const stalled = await createCampaign(ctx, { title: '卡住', bodyMarkdown: '嗨' });
    await store.updateCampaign(stalled.id, { status: 'sending', updatedAt: minutesAgo(40) });
    await store.createDeliveries([
      { id: 'dlv_stuck', campaignId: stalled.id, subscriberId: sub.id, email: sub.email, status: 'sending', attempts: 1, claimId: 'clm_1', claimedAt: minutesAgo(40) },
    ]);

    const report = await readinessReport(ctx);
    expect(report.ready).toBe(true);
    expect(report.ok).toBe(false);
    expect(report.alerts.map((a) => a.code).sort()).toEqual(
      ['deliveries_unconfirmed', 'scheduled_overdue', 'scheduler_stale', 'send_paused_long', 'sending_stalled'].sort(),
    );
    expect(report.backlog).toMatchObject({
      dueCampaigns: 1,
      overdueCampaigns: 1,
      sendingCampaigns: 1,
      stalledCampaigns: 1,
      unconfirmedDeliveries: 1,
      stuckDeliveries: 1,
    });
    expect(report.sending.blockedReason).toMatch(/SEND_PAUSED/);
  });

  it('排程關閉超過一天也會提醒；回執對帳（Portaly 回查）照樣啟用', async () => {
    const { ctx, store } = await makeContext({ scheduler: { enabled: false, pollMs: 1000, cronSecret: undefined } });
    ctx.config.email.provider = 'portaly';
    ctx.config.email.portalyApiKey = 'key';
    await store.setSetting(SCHEDULER_STATE_KEY, JSON.stringify({ schedulerDisabledSince: minutesAgo(30 * 60) }));
    await store.setSetting('portaly_delivery_sync', JSON.stringify({ lastRunAt: minutesAgo(5) }));

    const report = await readinessReport(ctx);
    expect(report.alerts.map((a) => a.code)).toEqual(['scheduler_disabled_long']);
    expect(report.receipts.mode).toBe('portaly_sync');
    expect(report.receipts.lastRunAt).not.toBeNull();
  });

  it('資料庫寫不進去：ready=false，提醒 store_unavailable', async () => {
    const { ctx, store } = await readOnlyContext();
    store.readOnly = true;
    const report = await readinessReport(ctx);
    expect(report.ready).toBe(false);
    expect(report.store.writable).toBe(false);
    expect(report.alerts[0]?.code).toBe('store_unavailable');
  });
});

describe('運作狀態端點', () => {
  async function serve(ctx: ServiceContext) {
    const server = createApp(ctx).listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  }

  it('/api/admin/readiness 要登入；strict=1 有提醒時回 503', async () => {
    const { ctx } = await makeContext({ scheduler: { enabled: true, pollMs: 1000, cronSecret: undefined } });
    const { server, base } = await serve(ctx);
    try {
      expect((await fetch(`${base}/api/admin/readiness`)).status).toBe(401);
      const auth = { authorization: 'Bearer test-admin-token' };
      const loose = await fetch(`${base}/api/admin/readiness`, { headers: auth });
      expect(loose.status).toBe(200);
      expect((await loose.json()).alerts[0].code).toBe('scheduler_never_ran');
      expect((await fetch(`${base}/api/admin/readiness?strict=1`, { headers: auth })).status).toBe(503);
    } finally {
      server.close();
    }
  });

  it('/api/cron/readiness 用 CRON_SECRET：正常 200、有問題 503，給 uptime 監控輪詢', async () => {
    const { ctx } = await makeContext({ scheduler: { enabled: true, pollMs: 1000, cronSecret: 's3cret' } });
    const { server, base } = await serve(ctx);
    try {
      expect((await fetch(`${base}/api/cron/readiness`)).status).toBe(401);
      const auth = { authorization: 'Bearer s3cret' };
      expect((await fetch(`${base}/api/cron/readiness`, { headers: auth })).status).toBe(503);
      expect((await fetch(`${base}/api/cron/tick`, { method: 'POST', headers: auth })).status).toBe(200);
      const res = await fetch(`${base}/api/cron/readiness`, { headers: auth });
      expect(res.status).toBe(200);
      expect((await res.json()).ok).toBe(true);
    } finally {
      server.close();
    }
  });

  it('公開訂閱 API 在資料庫寫不進去時回 503 與可辨識的 code', async () => {
    const { ctx, store } = await readOnlyContext();
    store.readOnly = true;
    const { server, base } = await serve(ctx);
    try {
      const res = await fetch(`${base}/api/public/subscribe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'x@example.com' }),
      });
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ code: STORE_UNAVAILABLE, error: expect.stringMatching(/暫停受理新訂閱/) });
    } finally {
      server.close();
    }
  });
});

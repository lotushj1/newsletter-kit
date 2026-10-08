import { afterEach, describe, expect, it, vi } from 'vitest';
import { scheduleBackgroundWork } from '../src/core/background.js';
import { createCampaign } from '../src/services/campaigns.js';
import { startCampaign } from '../src/services/sending.js';
import { createSubscriber } from '../src/services/subscribers.js';
import { makeContext } from './helpers.js';

const VERCEL_REQUEST_CONTEXT = Symbol.for('@vercel/request-context');

/** 模擬 Vercel 的 request context，收集交給 waitUntil 的工作。 */
function stubWaitUntil(): Promise<unknown>[] {
  const captured: Promise<unknown>[] = [];
  (globalThis as Record<symbol, unknown>)[VERCEL_REQUEST_CONTEXT] = {
    get: () => ({
      waitUntil: (promise: Promise<unknown>) => {
        captured.push(promise);
      },
    }),
  };
  return captured;
}

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[VERCEL_REQUEST_CONTEXT];
  vi.unstubAllEnvs();
});

describe('scheduleBackgroundWork', () => {
  it('有 waitUntil 時交給平台，回應後工作繼續跑', async () => {
    const captured = stubWaitUntil();
    let done = false;
    const scheduled = scheduleBackgroundWork(async () => {
      done = true;
    });
    expect(scheduled).toBe(true);
    expect(captured).toHaveLength(1);
    await captured[0];
    expect(done).toBe(true);
  });

  it('serverless 上拿不到 waitUntil 時回傳 false，不敢 fire-and-forget', () => {
    vi.stubEnv('VERCEL', '1');
    let started = false;
    const scheduled = scheduleBackgroundWork(async () => {
      started = true;
    });
    expect(scheduled).toBe(false);
    expect(started).toBe(false);
  });

  it('長駐程序照舊 fire-and-forget', async () => {
    let done = false;
    const scheduled = scheduleBackgroundWork(async () => {
      done = true;
    });
    expect(scheduled).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(done).toBe(true);
  });
});

describe('Vercel 上的背景寄送', () => {
  it('背景寄送掛上 waitUntil，函式不會在寄送中途被凍結', async () => {
    const captured = stubWaitUntil();
    const { ctx, adapter } = await makeContext();
    await createSubscriber(ctx, { email: 'a@example.com' });
    const campaign = await createCampaign(ctx, { title: 't', bodyMarkdown: '內容' });

    const { total, summary } = await startCampaign(ctx, campaign.id, { background: true });
    expect(total).toBe(1);
    expect(summary).toBeUndefined(); // 立即回應，工作在 waitUntil 裡

    expect(captured).toHaveLength(1);
    await captured[0];
    expect(adapter.sent.map((m) => m.to)).toEqual(['a@example.com']);
    expect((await ctx.store.getCampaign(campaign.id))?.status).toBe('sent');
  });

  it('serverless 沒有 waitUntil 時改在請求內寄完，不會斷頭', async () => {
    vi.stubEnv('VERCEL', '1');
    const { ctx, adapter } = await makeContext();
    await createSubscriber(ctx, { email: 'a@example.com' });
    const campaign = await createCampaign(ctx, { title: 't', bodyMarkdown: '內容' });

    const { summary } = await startCampaign(ctx, campaign.id, { background: true });
    expect(summary?.status).toBe('sent');
    expect(adapter.sent).toHaveLength(1);
    expect((await ctx.store.getCampaign(campaign.id))?.status).toBe('sent');
  });
});

describe('寄送失敗的狀態機', () => {
  it('背景寄送整個炸掉時標成 failed，不會停在寄送中或變回草稿', async () => {
    const captured = stubWaitUntil();
    const { ctx, store } = await makeContext();
    await createSubscriber(ctx, { email: 'a@example.com' });
    const campaign = await createCampaign(ctx, { title: 't', bodyMarkdown: '內容' });

    await startCampaign(ctx, campaign.id, { background: true });
    expect((await store.getCampaign(campaign.id))?.status).toBe('sending');

    // 模擬 store 在背景工作途中整個失效（例如 InsForge 逾時）
    const original = store.listDeliveries.bind(store);
    store.listDeliveries = async (campaignId, options) => {
      if (options?.status === 'pending') throw new Error('InsForgeError: Request timed out after 30000ms');
      return original(campaignId, options);
    };
    await captured[0];
    store.listDeliveries = original;

    expect((await store.getCampaign(campaign.id))?.status).toBe('failed');
  });

  it('重寄失敗的電子報會把失敗的收件人重新排入，冪等鍵不變', async () => {
    const { ctx, adapter, store } = await makeContext();
    await createSubscriber(ctx, { email: 'a@example.com' });
    await createSubscriber(ctx, { email: 'b@example.com' });
    const campaign = await createCampaign(ctx, { title: 't', bodyMarkdown: '內容' });

    adapter.behavior = () => ({ ok: false, error: '供應商掛了', retryable: false });
    const first = await startCampaign(ctx, campaign.id);
    expect(first.summary?.status).toBe('failed');

    const failedDeliveries = await store.listDeliveries(campaign.id, { status: 'failed' });
    expect(failedDeliveries).toHaveLength(2);

    adapter.behavior = () => null;
    const retry = await startCampaign(ctx, campaign.id);
    expect(retry.summary).toMatchObject({ total: 2, sent: 2, status: 'sent' });

    // 冪等鍵沿用同一筆 delivery id：若上次其實有寄出，供應商會擋掉重複
    const keys = adapter.sent.map((m) => m.idempotencyKey).sort();
    const ids = (await store.listDeliveries(campaign.id)).map((d) => d.id).sort();
    expect(keys).toEqual(ids);
  });
});

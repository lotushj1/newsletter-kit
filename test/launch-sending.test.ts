import { createHmac, randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Request } from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import type { EmailAdapter, EmailMessage, ProviderSentRecord, SendResult } from '../src/email/types.js';
import { adminActor, ADMIN_COOKIE, createGoogleAdminSession } from '../src/http/auth.js';
import { createApp } from '../src/http/app.js';
import { createCampaign } from '../src/services/campaigns.js';
import type { ServiceContext } from '../src/services/context.js';
import {
  campaignReceiptStats,
  deliveryState,
  receiptFromProviderStatus,
  receiptPatch,
} from '../src/services/delivery-receipts.js';
import { enrollSubscriber } from '../src/services/enroll.js';
import { syncPortalyDeliveries } from '../src/services/portaly-sync.js';
import {
  listReconcileQueue,
  reconcileUnconfirmed,
  sendCampaignToSubscriber,
  sequenceDeliveryId,
  startCampaign,
} from '../src/services/sending.js';
import { createSequence, processDueEnrollments } from '../src/services/sequences.js';
import { createSubscriber } from '../src/services/subscribers.js';
import type { Delivery } from '../src/store/types.js';
import { makeContext, testConfig } from './helpers.js';

/**
 * 模擬寄信服務（比照 Portaly）：以冪等鍵（寄送紀錄 id）記錄收下的信，可用 ref 反查，
 * 也可以指定查詢時回報的收件狀態。絕不對外連線。
 */
function mockProvider(options: { lookup?: boolean } = {}) {
  const accepted = new Map<string, EmailMessage>();
  const statuses = new Map<string, string>();
  const calls: EmailMessage[] = [];
  let next: ((message: EmailMessage) => SendResult | 'throw') | null = null;
  let lookupError: Error | null = null;
  const adapter: EmailAdapter = {
    name: 'mock-provider',
    async verify() {
      return { ok: true, message: 'mock' };
    },
    async send(message) {
      calls.push(message);
      const scripted = next?.(message);
      next = null;
      if (scripted === 'throw') {
        accepted.set(message.idempotencyKey!, message); // 服務商其實收下了，只是呼叫端丟錯
        throw new Error('socket hang up');
      }
      if (scripted) {
        if (!scripted.ok && scripted.outcomeUnknown) accepted.set(message.idempotencyKey!, message);
        return scripted;
      }
      accepted.set(message.idempotencyKey!, message);
      return { ok: true, id: `emsg_${message.idempotencyKey}` };
    },
  };
  if (options.lookup !== false) {
    adapter.findSentByRefs = async (refs: string[]) => {
      if (lookupError) throw lookupError;
      const found = new Map<string, ProviderSentRecord>();
      for (const ref of refs) {
        if (!accepted.has(ref)) continue;
        found.set(ref, {
          ref,
          providerMessageId: `emsg_${ref}`,
          acceptedAt: '2026-11-20T00:00:00.000Z',
          recipientStatus: statuses.get(ref),
        });
      }
      return found;
    };
  }
  return {
    adapter,
    accepted,
    calls,
    statuses,
    nextWith(fn: (message: EmailMessage) => SendResult | 'throw') {
      next = fn;
    },
    failLookup(error: Error) {
      lookupError = error;
    },
  };
}

async function setup(options: { lookup?: boolean } = {}) {
  const provider = mockProvider(options);
  const made = await makeContext();
  made.ctx.adapter = provider.adapter;
  return { ...made, provider };
}

async function seedCampaign(ctx: ServiceContext, count: number, title = '第 1 期') {
  for (let i = 0; i < count; i += 1) await createSubscriber(ctx, { email: `reader${i}-${title.length}@example.com` });
  return createCampaign(ctx, { title, bodyMarkdown: '內容' });
}

/** 讓前 n 封的結果都是「結果不明」（服務商其實收下了）。 */
function unknownFor(provider: ReturnType<typeof mockProvider>, keys: Set<string>) {
  const original = provider.adapter.send.bind(provider.adapter);
  provider.adapter.send = async (message) => {
    if (keys.has(message.to)) {
      provider.accepted.set(message.idempotencyKey!, message);
      provider.calls.push(message);
      return { ok: false, error: '逾時', retryable: true, outcomeUnknown: true };
    }
    return original(message);
  };
}

describe('序列信：先 claim、結果不明不重寄', () => {
  it('同一個入隊步驟用固定 id，重跑只會寄一次', async () => {
    const { ctx, provider } = await setup();
    const campaign = await createCampaign(ctx, { title: '歡迎', bodyHtml: '<p>嗨</p>' });
    const subscriber = await createSubscriber(ctx, { email: 'seq-a@example.com' });
    const deliveryId = sequenceDeliveryId('enr_test', 0);

    expect(await sendCampaignToSubscriber(ctx, campaign, subscriber, { deliveryId })).toEqual({ ok: true });
    expect(await sendCampaignToSubscriber(ctx, campaign, subscriber, { deliveryId })).toEqual({ ok: true });
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]!.idempotencyKey).toBe(deliveryId);
    const delivery = await ctx.store.getDelivery(deliveryId);
    expect(delivery).toMatchObject({ status: 'sent', attempts: 1, receipt: 'accepted', providerMessageId: `emsg_${deliveryId}` });
    expect(delivery?.claimedAt).toBeTruthy();
  });

  it('結果不明留在 sending（不是 failed），之後重跑也不會再寄', async () => {
    const { ctx, provider } = await setup();
    const campaign = await createCampaign(ctx, { title: '歡迎', bodyHtml: '<p>嗨</p>' });
    const subscriber = await createSubscriber(ctx, { email: 'seq-b@example.com' });
    const deliveryId = sequenceDeliveryId('enr_test', 1);
    provider.nextWith(() => ({ ok: false, error: '逾時', retryable: true, outcomeUnknown: true }));

    const first = await sendCampaignToSubscriber(ctx, campaign, subscriber, { deliveryId });
    expect(first).toMatchObject({ ok: false, outcomeUnknown: true });
    expect(await ctx.store.getDelivery(deliveryId)).toMatchObject({ status: 'sending', error: '逾時' });

    const again = await sendCampaignToSubscriber(ctx, campaign, subscriber, { deliveryId });
    expect(again).toMatchObject({ ok: false, outcomeUnknown: true });
    expect(provider.calls).toHaveLength(1);
    expect((await ctx.store.deliveryStats(campaign.id)).unconfirmed).toBe(1);
  });

  it('adapter 丟錯時不會留在 pending，記成結果不明', async () => {
    const { ctx, provider } = await setup();
    const campaign = await createCampaign(ctx, { title: '歡迎', bodyHtml: '<p>嗨</p>' });
    const subscriber = await createSubscriber(ctx, { email: 'seq-c@example.com' });
    provider.nextWith(() => 'throw');

    const result = await sendCampaignToSubscriber(ctx, campaign, subscriber);
    expect(result).toMatchObject({ ok: false, outcomeUnknown: true });
    const [delivery] = await ctx.store.listDeliveries(campaign.id);
    expect(delivery).toMatchObject({ status: 'sending', attempts: 1 });
    expect(delivery?.error).toContain('結果不明');
  });

  it('服務商確定拒收時記成 failed 並清掉 claim', async () => {
    const { ctx, provider } = await setup();
    const campaign = await createCampaign(ctx, { title: '歡迎', bodyHtml: '<p>嗨</p>' });
    const subscriber = await createSubscriber(ctx, { email: 'seq-d@example.com' });
    provider.nextWith(() => ({ ok: false, error: '400 bad request', retryable: false }));

    expect(await sendCampaignToSubscriber(ctx, campaign, subscriber)).toEqual({ ok: false, error: '400 bad request' });
    const [delivery] = await ctx.store.listDeliveries(campaign.id);
    expect(delivery).toMatchObject({ status: 'failed', error: '400 bad request' });
    expect(delivery?.claimId).toBeUndefined();
  });

  it('寄送紀錄已被別的程序領走時不寄', async () => {
    const { ctx, provider } = await setup();
    const campaign = await createCampaign(ctx, { title: '歡迎', bodyHtml: '<p>嗨</p>' });
    const subscriber = await createSubscriber(ctx, { email: 'seq-e@example.com' });
    const deliveryId = sequenceDeliveryId('enr_race', 0);
    await ctx.store.createDeliveries([
      { id: deliveryId, campaignId: campaign.id, subscriberId: subscriber.id, email: subscriber.email, status: 'pending', attempts: 0 },
    ]);
    // 另一個程序剛好在這之後領走
    const originalGet = ctx.store.getDelivery.bind(ctx.store);
    ctx.store.getDelivery = async (id: string) => {
      const found = await originalGet(id);
      await ctx.store.claimDeliveries([id], { claimId: 'clm_other', claimedAt: new Date().toISOString() });
      return found;
    };
    const result = await sendCampaignToSubscriber(ctx, campaign, subscriber, { deliveryId });
    expect(result.ok).toBe(false);
    expect(provider.calls).toHaveLength(0);
  });

  it('排程跑序列時用入隊 id＋步驟當寄送紀錄 id，結果不明也照樣往下一步走', async () => {
    const { ctx, provider } = await setup();
    const campaign = await createCampaign(ctx, { title: '歡迎', bodyHtml: '<p>嗨</p>' });
    const sequence = await createSequence(ctx, {
      name: '歡迎序列',
      trigger: 'subscribe',
      steps: [{ delayDays: 0, campaignId: campaign.id }],
    });
    const subscriber = await createSubscriber(ctx, { email: 'seq-f@example.com' });
    await enrollSubscriber(ctx, subscriber, { type: 'subscribe' });
    const enrollment = (await ctx.store.getEnrollment(sequence.id, subscriber.id))!;
    provider.nextWith(() => ({ ok: false, error: '逾時', retryable: true, outcomeUnknown: true }));

    expect(await processDueEnrollments(ctx)).toBe(0);
    expect(await ctx.store.getDelivery(sequenceDeliveryId(enrollment.id, 0))).toMatchObject({ status: 'sending' });
    expect((await ctx.store.getEnrollment(sequence.id, subscriber.id))?.status).toBe('completed');
    expect(provider.calls).toHaveLength(1);
  });
});

describe('電子報寄送：adapter 丟錯視為結果不明', () => {
  it('沒有 sendBatch 的 adapter 丟錯時留在 sending，重寄失敗的電子報也不會再寄', async () => {
    const { ctx, provider } = await setup();
    const campaign = await seedCampaign(ctx, 3);
    provider.nextWith(() => 'throw');

    const { summary } = await startCampaign(ctx, campaign.id);
    expect(summary).toMatchObject({ status: 'failed', unconfirmed: 1 });
    const unknown = await ctx.store.listDeliveries(campaign.id, { status: 'sending' });
    expect(unknown).toHaveLength(1);
    expect(unknown[0]!.error).toContain('結果不明');
    expect(provider.calls).toHaveLength(3);
  });
});

describe('對帳：一律留下結果與原因，不盲目重寄', () => {
  it('查到的依服務商回報標成已送達／被檢舉／退信，查不到的維持不明並記原因', async () => {
    const { ctx, store, provider } = await setup();
    const campaign = await seedCampaign(ctx, 5);
    const subscribers = (await store.listSubscribers({ limit: 10 })).items.map((s) => s.email);
    // 前 4 封結果不明（服務商其實都收下了），第 5 封正常
    unknownFor(provider, new Set(subscribers.slice(0, 4)));
    await startCampaign(ctx, campaign.id);
    const unknown = await store.listDeliveries(campaign.id, { status: 'sending' });
    expect(unknown).toHaveLength(4);
    const [delivered, complained, bounced, missing] = unknown as [Delivery, Delivery, Delivery, Delivery];
    provider.statuses.set(delivered.id, 'delivered');
    provider.statuses.set(complained.id, 'complained');
    provider.statuses.set(bounced.id, 'bounced');
    provider.accepted.delete(missing.id); // 服務商查不到

    const summary = await reconcileUnconfirmed(ctx, campaign.id, 'admin@example.com');
    expect(summary).toMatchObject({ checked: 4, confirmed: 3, undelivered: 1, stillUnknown: 1, supported: true });
    expect(summary.reason).toContain('仍不明 1 筆');

    const after = new Map((await store.listDeliveries(campaign.id)).map((d) => [d.id, d]));
    expect(after.get(delivered.id)).toMatchObject({ status: 'sent', receipt: 'delivered' });
    expect(after.get(complained.id)).toMatchObject({ status: 'sent', receipt: 'complained' });
    expect(after.get(bounced.id)).toMatchObject({ status: 'failed', receipt: 'bounced', providerMessageId: `emsg_${bounced.id}` });
    expect(after.get(missing.id)).toMatchObject({ status: 'sending' });
    for (const id of [delivered.id, complained.id, bounced.id, missing.id]) {
      expect(after.get(id)?.reconcile).toMatchObject({ by: 'admin@example.com' });
      expect(after.get(id)?.reconcile?.at).toBeTruthy();
      expect(after.get(id)?.reconcile?.note).toBeTruthy();
    }
    expect(after.get(missing.id)?.reconcile?.result).toBe('not_found');
    expect(after.get(delivered.id)?.reconcile?.result).toBe('confirmed');

    // 對帳查到退信的那筆有服務商訊息 id：重寄失敗的電子報時不會再寄給他；結果不明的也不會。
    await store.updateDelivery(missing.id, { status: 'sent' }); // 人工確認後，讓電子報可以重寄
    const callsBefore = provider.calls.length;
    await startCampaign(ctx, campaign.id);
    expect(provider.calls.length).toBe(callsBefore);
  });

  it('寄信服務沒有查詢 API：不改狀態，記下「不支援」與原因', async () => {
    const { ctx, store, provider } = await setup({ lookup: false });
    const campaign = await seedCampaign(ctx, 2);
    provider.nextWith(() => ({ ok: false, error: '逾時', outcomeUnknown: true }));
    await startCampaign(ctx, campaign.id);

    const summary = await reconcileUnconfirmed(ctx, campaign.id, '管理員權杖');
    expect(summary).toMatchObject({ checked: 1, confirmed: 0, stillUnknown: 1, supported: false });
    expect(summary.reason).toContain('沒有查詢 API');
    const [delivery] = await store.listDeliveries(campaign.id, { status: 'sending' });
    expect(delivery?.reconcile).toMatchObject({ result: 'unsupported', by: '管理員權杖' });
  });

  it('查詢本身失敗：不丟錯、不改狀態，記下失敗原因', async () => {
    const { ctx, store, provider } = await setup();
    const campaign = await seedCampaign(ctx, 2);
    provider.nextWith(() => ({ ok: false, error: '逾時', outcomeUnknown: true }));
    await startCampaign(ctx, campaign.id);
    provider.failLookup(new Error('Portaly 503'));

    const summary = await reconcileUnconfirmed(ctx, campaign.id);
    expect(summary).toMatchObject({ confirmed: 0, stillUnknown: 1, lookupError: 'Portaly 503' });
    const [delivery] = await store.listDeliveries(campaign.id, { status: 'sending' });
    expect(delivery?.reconcile).toMatchObject({ result: 'lookup_failed', by: '系統' });
    expect(delivery?.reconcile?.note).toContain('Portaly 503');
  });

  it('跨電子報的待對帳清單：最早的排前面，帶電子報、參考值與對帳紀錄', async () => {
    const { ctx, store } = await setup();
    const first = await createCampaign(ctx, { title: '第 1 期', bodyMarkdown: '內容' });
    const second = await createCampaign(ctx, { title: '第 2 期', bodyMarkdown: '內容' });
    const base = { subscriberId: 'sub_x', attempts: 1 };
    await store.createDeliveries([
      { ...base, id: 'dlv_late', campaignId: first.id, email: 'late@example.com', status: 'pending' },
      { ...base, id: 'dlv_early', campaignId: second.id, email: 'early@example.com', status: 'pending' },
      { ...base, id: 'dlv_done', campaignId: first.id, email: 'done@example.com', status: 'sent' },
    ]);
    await store.claimDeliveries(['dlv_late'], { claimId: 'clm_1', claimedAt: '2026-11-20T02:00:00.000Z' });
    await store.claimDeliveries(['dlv_early'], { claimId: 'clm_2', claimedAt: '2026-11-20T01:00:00.000Z' });

    const queue = await listReconcileQueue(ctx);
    expect(queue.total).toBe(2);
    expect(queue.earliestAt).toBe('2026-11-20T01:00:00.000Z');
    expect(queue.lookup).toEqual({ provider: 'mock-provider', supported: true });
    expect(queue.items.map((i) => i.id)).toEqual(['dlv_early', 'dlv_late']);
    expect(queue.items[0]).toMatchObject({
      campaignTitle: '第 2 期',
      lookupRef: 'dlv_early',
      claimedAt: '2026-11-20T01:00:00.000Z',
    });

    await reconcileUnconfirmed(ctx, second.id, 'admin@example.com');
    const after = await listReconcileQueue(ctx);
    expect(after.items.find((i) => i.id === 'dlv_early')?.reconcile).toMatchObject({ result: 'not_found', by: 'admin@example.com' });
  });
});

describe('服務商回報：已收下／已送達／退信／檢舉／結果不明分得開', () => {
  it('寄送狀態對照', () => {
    expect(deliveryState({ status: 'sending' })).toBe('unknown');
    expect(deliveryState({ status: 'sent' })).toBe('accepted'); // 舊資料沒有回報
    expect(deliveryState({ status: 'sent', receipt: 'delivered' })).toBe('delivered');
    expect(deliveryState({ status: 'sent', receipt: 'complained' })).toBe('complained');
    expect(deliveryState({ status: 'failed', receipt: 'bounced' })).toBe('bounced');
    expect(deliveryState({ status: 'failed', receipt: 'accepted' })).toBe('failed');
    expect(deliveryState({ status: 'failed' })).toBe('failed');
    expect(deliveryState({ status: 'pending' })).toBe('pending');
    expect(receiptFromProviderStatus('delivered')).toBe('delivered');
    expect(receiptFromProviderStatus('suppressed')).toBe('failed');
    expect(receiptFromProviderStatus('queued')).toBe('accepted');
    expect(receiptFromProviderStatus(undefined)).toBe('accepted');
  });

  it('較弱的回報不會蓋掉較強的', () => {
    expect(receiptPatch({ receipt: 'complained' }, 'delivered')).toBeNull();
    expect(receiptPatch({ receipt: 'accepted' }, 'delivered')).toMatchObject({ receipt: 'delivered' });
    expect(receiptPatch({ receipt: 'delivered' }, 'bounced')).toMatchObject({ receipt: 'bounced' });
    expect(receiptPatch({ receipt: 'bounced' }, 'bounced')).toBeNull();
  });

  it('電子報統計：寄出記成「服務商已收下」，結果不明另外算', async () => {
    const { ctx, store, provider } = await setup();
    const campaign = await seedCampaign(ctx, 3);
    provider.nextWith(() => ({ ok: false, error: '逾時', outcomeUnknown: true }));
    await startCampaign(ctx, campaign.id);

    const stats = await campaignReceiptStats(ctx, campaign.id);
    expect(stats).toMatchObject({ total: 3, unknown: 1, accepted: 2, delivered: 0 });
    // 既有的 status 統計不變
    expect(await store.deliveryStats(campaign.id)).toMatchObject({ total: 3, sent: 2, unconfirmed: 1 });
  });

  it('開信、點擊不算送達證據', async () => {
    const { ctx, store } = await setup();
    const campaign = await seedCampaign(ctx, 1);
    await startCampaign(ctx, campaign.id);
    const [delivery] = await store.listDeliveries(campaign.id);
    await store.createEvent({
      id: 'evt_open',
      campaignId: campaign.id,
      deliveryId: delivery!.id,
      subscriberId: delivery!.subscriberId,
      type: 'open',
      createdAt: new Date().toISOString(),
    });
    expect((await campaignReceiptStats(ctx, campaign.id)).delivered).toBe(0);
    expect(deliveryState((await store.getDelivery(delivery!.id))!)).toBe('accepted');
  });

  it('Portaly 回查：退信記成 bounced（failed），檢舉記成 complained（維持 sent）', async () => {
    const { ctx, store } = await makeContext();
    ctx.config.email.provider = 'portaly';
    ctx.config.email.portalyApiKey = 'pem_test_key';
    await store.createDeliveries([
      { id: 'dlv_b', campaignId: 'cmp_1', subscriberId: 'sub_b', email: 'b@example.com', status: 'sent', attempts: 1, providerMessageId: 'emsg_b', receipt: 'accepted' },
      { id: 'dlv_c', campaignId: 'cmp_1', subscriberId: 'sub_c', email: 'c@example.com', status: 'sent', attempts: 1, providerMessageId: 'emsg_c' },
      { id: 'dlv_s', campaignId: 'cmp_1', subscriberId: 'sub_s', email: 's@example.com', status: 'sent', attempts: 1, providerMessageId: 'emsg_s' },
    ]);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: 'emsg_b', recipients: [{ status: 'bounced' }] },
            { id: 'emsg_c', recipients: [{ status: 'complained' }] },
            { id: 'emsg_s', recipients: [{ status: 'suppressed' }] },
          ],
          pagination: { hasMore: false },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;
    try {
      await syncPortalyDeliveries(ctx);
      const second = await syncPortalyDeliveries(ctx);
      expect(second.updated).toBe(0); // 同一份回報再來一次不算變動
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(await store.getDelivery('dlv_b')).toMatchObject({ status: 'failed', receipt: 'bounced' });
    expect(await store.getDelivery('dlv_c')).toMatchObject({ status: 'sent', receipt: 'complained' });
    expect(await store.getDelivery('dlv_s')).toMatchObject({ status: 'failed', receipt: 'failed' });
    const stats = await campaignReceiptStats(ctx, 'cmp_1');
    expect(stats).toMatchObject({ bounced: 1, complained: 1, failed: 1, accepted: 0 });
  });
});

describe('後台 API', () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise((resolve) => server!.close(resolve));
    server = undefined;
  });

  async function listen(ctx: ServiceContext): Promise<string> {
    server = createApp(ctx).listen(0);
    await new Promise((resolve) => server!.once('listening', resolve));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  }
  const admin = { authorization: 'Bearer test-admin-token', 'content-type': 'application/json' };

  it('待對帳清單、寄送紀錄的狀態篩選、回報統計、對帳者', async () => {
    const { ctx, provider } = await setup();
    const campaign = await seedCampaign(ctx, 3);
    provider.nextWith(() => ({ ok: false, error: '逾時', outcomeUnknown: true }));
    await startCampaign(ctx, campaign.id);
    provider.accepted.clear(); // 服務商查不到
    const base = await listen(ctx);

    const queue = await (await fetch(`${base}/api/admin/deliveries/unconfirmed`, { headers: admin })).json();
    expect(queue).toMatchObject({ total: 1, lookup: { supported: true } });
    expect(queue.items[0]).toMatchObject({ campaignId: campaign.id, campaignTitle: '第 1 期' });

    const filtered = await (await fetch(`${base}/api/admin/campaigns/${campaign.id}/deliveries?status=sending`, { headers: admin })).json();
    expect(filtered.items).toHaveLength(1);
    expect(filtered.items[0]).toMatchObject({ status: 'sending', state: 'unknown' });
    const all = await (await fetch(`${base}/api/admin/campaigns/${campaign.id}/deliveries`, { headers: admin })).json();
    expect(all.items).toHaveLength(3);
    expect((await fetch(`${base}/api/admin/campaigns/${campaign.id}/deliveries?status=nope`, { headers: admin })).status).toBe(400);

    const receipts = await (await fetch(`${base}/api/admin/campaigns/${campaign.id}/receipts`, { headers: admin })).json();
    expect(receipts).toMatchObject({ total: 3, accepted: 2, unknown: 1 });

    const reconciled = await (await fetch(`${base}/api/admin/campaigns/${campaign.id}/reconcile`, { method: 'POST', headers: admin })).json();
    expect(reconciled).toMatchObject({ checked: 1, stillUnknown: 1 });
    expect(reconciled.reason).toBeTruthy();
    const [unknown] = await ctx.store.listDeliveries(campaign.id, { status: 'sending' });
    expect(unknown?.reconcile).toMatchObject({ by: 'admin-token', result: 'not_found' });
  });

  it('供應商 webhook 帶訊息 id 時，退信／檢舉也記成寄送紀錄的回報', async () => {
    const made = await makeContext({ webhookSecrets: { generic: 'generic-secret' } });
    const { ctx, store } = made;
    for (const id of ['1', '2']) {
      await store.createSubscriber({ id: `sub_w${id}`, email: `hook${id}@example.com`, status: 'subscribed', tags: [], createdAt: new Date().toISOString() });
    }
    await store.createDeliveries([
      { id: 'dlv_w1', campaignId: 'cmp_w', subscriberId: 'sub_w1', email: 'hook1@example.com', status: 'sent', attempts: 1, providerMessageId: 'pm_1', receipt: 'accepted' },
      { id: 'dlv_w2', campaignId: 'cmp_w', subscriberId: 'sub_w2', email: 'hook2@example.com', status: 'sent', attempts: 1, providerMessageId: 'pm_2', receipt: 'accepted' },
    ]);
    const base = await listen(ctx);
    const post = async (payload: object) => {
      const body = JSON.stringify(payload);
      const signature = 'sha256=' + createHmac('sha256', 'generic-secret').update(body).digest('hex');
      return fetch(`${base}/api/webhooks/generic`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-newsletter-signature': signature }, body });
    };
    expect((await post({ type: 'complaint', email: 'hook1@example.com', providerMessageId: 'pm_1' })).status).toBe(200);
    expect((await post({ type: 'hard_bounce', email: 'hook2@example.com', providerMessageId: 'pm_2' })).status).toBe(200);
    expect(await store.getDelivery('dlv_w1')).toMatchObject({ status: 'sent', receipt: 'complained' });
    expect(await store.getDelivery('dlv_w2')).toMatchObject({ status: 'failed', receipt: 'bounced' });
  });

  it('Google 登入的對帳者記成登入信箱', () => {
    const config = testConfig({
      google: {
        clientId: 'test-client.apps.googleusercontent.com',
        // 測試用的假值，每次執行隨機產生。
        clientSecret: randomBytes(16).toString('hex'),
        adminEmails: ['admin@example.com'],
        redirectUri: 'https://newsletter.test/admin/auth/google/callback',
      },
    });
    const cookie = createGoogleAdminSession(config, 'Admin@Example.com');
    const req = { headers: { cookie: `${ADMIN_COOKIE}=${encodeURIComponent(cookie)}` } } as unknown as Request;
    expect(adminActor(config, req)).toBe('admin@example.com');
    const tokenReq = { headers: { cookie: `${ADMIN_COOKIE}=${config.adminToken}` } } as unknown as Request;
    expect(adminActor(config, tokenReq)).toBe('admin-token');
  });
});

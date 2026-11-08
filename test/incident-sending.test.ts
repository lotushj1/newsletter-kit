import { describe, expect, it } from 'vitest';
import type { InsForgeBackend } from '../src/core/insforge.js';
import type { EmailMessage, ProviderSentRecord, SendResult } from '../src/email/types.js';
import { createCampaign } from '../src/services/campaigns.js';
import { createScheduler } from '../src/services/scheduler.js';
import {
  reconcileUnconfirmed,
  resumeCampaign,
  startCampaign,
} from '../src/services/sending.js';
import { createSubscriber, unsubscribeByEmail } from '../src/services/subscribers.js';
import { InsForgeStore } from '../src/store/insforge-store.js';
import { MemoryStore, type MemorySnapshot } from '../src/store/memory-store.js';
import type { DeliveryUpdate } from '../src/store/types.js';
import { makeContext, testConfig } from './helpers.js';

/**
 * 模擬寄信服務：記錄每一封「被服務商收下」的信，以 idempotencyKey（delivery id）去重，
 * 並能用 ref 反查——行為比照 Portaly。絕不對外連線。
 */
function mockProvider() {
  const accepted = new Map<string, EmailMessage>();
  const calls: EmailMessage[] = [];
  let failNext: SendResult | null = null;
  return {
    accepted,
    calls,
    failNextWith(result: SendResult) {
      failNext = result;
    },
    adapter: {
      name: 'mock-provider',
      async verify() {
        return { ok: true, message: 'mock' };
      },
      async send(message: EmailMessage): Promise<SendResult> {
        calls.push(message);
        if (failNext) {
          const result = failNext;
          failNext = null;
          // 結果不明的情境：服務商其實收下了，只是回應丟失。
          if (!result.ok && result.outcomeUnknown) accepted.set(message.idempotencyKey!, message);
          return result;
        }
        accepted.set(message.idempotencyKey!, message);
        return { ok: true, id: `emsg_${message.idempotencyKey}` };
      },
      async findSentByRefs(refs: string[]) {
        const found = new Map<string, ProviderSentRecord>();
        for (const ref of refs) {
          if (accepted.has(ref)) found.set(ref, { ref, providerMessageId: `emsg_${ref}`, acceptedAt: new Date().toISOString() });
        }
        return found;
      },
    },
  };
}

/** 每個收件地址被服務商收下幾次。 */
function perRecipient(provider: ReturnType<typeof mockProvider>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const message of provider.accepted.values()) counts.set(message.to, (counts.get(message.to) ?? 0) + 1);
  return counts;
}

async function seed(ctx: Awaited<ReturnType<typeof makeContext>>['ctx'], count: number) {
  for (let i = 0; i < count; i += 1) await createSubscriber(ctx, { email: `reader${i}@example.com` });
  return createCampaign(ctx, { title: '第 12 期', bodyMarkdown: '內容' });
}

class FlakyStore extends MemoryStore {
  failUpdatesAfterSend = false;
  override async updateDeliveries(updates: DeliveryUpdate[]): Promise<number> {
    if (this.failUpdatesAfterSend && updates.some((u) => u.patch.status === 'sent')) {
      throw new Error('模擬 InsForge 寫入失敗');
    }
    return super.updateDeliveries(updates);
  }
}

describe('寄送冪等與續寄保護（模擬寄信服務）', () => {
  it('服務商已收下、但本機紀錄寫回失敗：立刻停止，之後續寄也不會重寄那一批', async () => {
    const provider = mockProvider();
    const store = new FlakyStore();
    await store.init();
    const ctx = { config: testConfig(), store, adapter: provider.adapter, ai: null };
    const campaign = await seed(ctx, 6); // batchSize 2

    store.failUpdatesAfterSend = true;
    const result = await startCampaign(ctx, campaign.id).catch((error: Error) => error);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/寫回失敗/);

    // 只有第一批 2 封被收下，沒有繼續寄後面的
    expect(provider.accepted.size).toBe(2);
    const deliveries = await store.listDeliveries(campaign.id);
    expect(deliveries.filter((d) => d.status === 'sending')).toHaveLength(2);
    expect(deliveries.filter((d) => d.status === 'pending')).toHaveLength(4);

    // 儲存恢復後人工續寄：停在 sending 的 2 筆不會再寄
    store.failUpdatesAfterSend = false;
    await resumeCampaign(ctx, campaign.id);
    expect(provider.accepted.size).toBe(6);
    expect([...perRecipient(provider).values()].every((n) => n === 1)).toBe(true);
    expect(provider.calls).toHaveLength(6);

    // 對帳：服務商查得到 → 改成 sent
    const reconciled = await reconcileUnconfirmed(ctx, campaign.id);
    expect(reconciled).toMatchObject({ checked: 2, confirmed: 2, stillUnknown: 0 });
    expect((await store.deliveryStats(campaign.id)).sent).toBe(6);
  });

  it('結果不明（逾時、5xx）的寄送紀錄停在 sending，重寄失敗的電子報時也不會再寄', async () => {
    const provider = mockProvider();
    const { ctx, store } = await makeContext();
    ctx.adapter = provider.adapter;
    const campaign = await seed(ctx, 3);
    provider.failNextWith({ ok: false, error: '逾時', retryable: true, outcomeUnknown: true });

    const { summary } = await startCampaign(ctx, campaign.id);
    expect(summary?.status).toBe('failed');
    expect(summary?.unconfirmed).toBe(1);

    // 後台按「重寄」：只會把 failed/pending 排回，sending 那筆不動
    await startCampaign(ctx, campaign.id);
    expect([...perRecipient(provider).values()].every((n) => n === 1)).toBe(true);
    expect(provider.calls).toHaveLength(3);
    expect((await store.deliveryStats(campaign.id)).unconfirmed).toBe(1);
  });

  it('部署／重啟後的排程 tick 不會自動續寄「寄送中」，也不會清掉待寄佇列', async () => {
    const provider = mockProvider();
    const { ctx, store } = await makeContext({
      scheduler: { enabled: true, pollMs: 1000, cronSecret: undefined },
    });
    ctx.adapter = provider.adapter;
    const campaign = await seed(ctx, 4);
    await store.createDeliveries(
      (await store.listSubscribers({ limit: 100 })).items.map((s, i) => ({
        id: `dlv_${i}`,
        campaignId: campaign.id,
        subscriberId: s.id,
        email: s.email,
        status: 'pending' as const,
        attempts: 0,
      })),
    );
    await store.updateCampaign(campaign.id, { status: 'sending', updatedAt: new Date().toISOString() });

    const summary = await createScheduler(ctx).tick();
    expect(summary.resumed).toBe(0);
    expect(provider.calls).toHaveLength(0);
    expect(await store.listDeliveries(campaign.id, { status: 'pending' })).toHaveLength(4);
    expect((await store.getCampaign(campaign.id))?.status).toBe('sending');
  });

  it('SEND_PAUSED=true 時手動寄送與排程都不會寄', async () => {
    const provider = mockProvider();
    const { ctx } = await makeContext({
      scheduler: { enabled: true, pollMs: 1000, cronSecret: undefined },
    });
    ctx.config.send.paused = true;
    ctx.adapter = provider.adapter;
    const campaign = await seed(ctx, 2);
    await expect(startCampaign(ctx, campaign.id)).rejects.toThrow(/暫停/);
    const summary = await createScheduler(ctx).tick();
    expect(summary.skippedReason).toBe('sending_blocked');
    expect(provider.calls).toHaveLength(0);
  });

  it('時間預算用完就收手，campaign 保持寄送中、剩下的仍在佇列', async () => {
    const provider = mockProvider();
    const { ctx, store } = await makeContext();
    ctx.adapter = provider.adapter;
    ctx.config.send.timeBudgetMs = 1;
    ctx.config.send.batchDelayMs = 5;
    const campaign = await seed(ctx, 6);
    const { summary } = await startCampaign(ctx, campaign.id);
    expect(summary?.paused).toBe('time_budget');
    expect((await store.getCampaign(campaign.id))?.status).toBe('sending');
    const pending = await store.listDeliveries(campaign.id, { status: 'pending' });
    expect(pending.length).toBeGreaterThan(0);
    expect(provider.accepted.size + pending.length).toBe(6);
  });
});

describe('資料遺失期間的退訂', () => {
  it('名單裡找不到的人按退訂會留下排除紀錄；之後還原名單也不會寄給他', async () => {
    const provider = mockProvider();
    const { ctx, store } = await makeContext();
    ctx.adapter = provider.adapter;

    // 資料被清空期間：名單是空的，有人按了退訂
    const result = await unsubscribeByEmail(ctx, 'Lost.Reader@example.com');
    expect(result.ok).toBe(true);

    // 之後從備份還原（訂閱狀態仍是 subscribed）
    await store.createSubscriber({
      id: 'sub_restored',
      email: 'lost.reader@example.com',
      status: 'subscribed',
      tags: [],
      createdAt: '2026-11-01T00:00:00.000Z',
    });
    await createSubscriber(ctx, { email: 'stay@example.com' });
    const campaign = await createCampaign(ctx, { title: '#055', bodyMarkdown: '內容' });
    await startCampaign(ctx, campaign.id);

    expect(provider.calls.map((m) => m.to)).toEqual(['stay@example.com']);
    // 受眾篩選就排除了排除名單內的地址，連寄送紀錄都不會建立
    const deliveries = await store.listDeliveries(campaign.id);
    expect(deliveries.map((d) => d.email)).toEqual(['stay@example.com']);
  });
});

type Versioned = MemorySnapshot & { __nk_version?: number };

/** 有條件更新（CAS）且每次讀寫都會讓出事件迴圈的共用後端，用來逼出並行交錯。 */
function casBackend(initial: Versioned) {
  let current: Versioned = structuredClone(initial);
  const tick = () => new Promise((resolve) => setTimeout(resolve, Math.random() * 3));
  return {
    current: () => current,
    make(): InsForgeBackend {
      return {
        async loadSnapshot() {
          await tick();
          return structuredClone(current);
        },
        async saveSnapshot(snapshot, options = {}) {
          await tick();
          const expected = options.expectedVersion;
          if (expected !== undefined && (current.__nk_version ?? 0) !== expected) {
            const { SnapshotConflictError } = await import('../src/store/snapshot-guard.js');
            throw new SnapshotConflictError('version moved');
          }
          current = structuredClone(snapshot as Versioned);
        },
        async snapshotExists() {
          return true;
        },
        async uploadImage(fileName) {
          return { url: fileName };
        },
        async sendEmail() {
          return {};
        },
      };
    },
  };
}

describe('多實例並行領取（InsForge 條件更新）', () => {
  it('兩個實例同時領同一批寄送紀錄，每一筆只會被一個實例領到', async () => {
    const ids = Array.from({ length: 20 }, (_, i) => `dlv_${i}`);
    const backend = casBackend({
      subscribers: [],
      campaigns: [],
      deliveries: ids.map((id) => ({ id, campaignId: 'cmp', subscriberId: id, email: `${id}@example.com`, status: 'pending', attempts: 0 })),
      events: [],
      sequences: [],
      sequenceSteps: [],
      enrollments: [],
      folders: [],
      templates: [],
      settings: {},
      campaignStarters: [],
      __nk_version: 10,
    });
    const a = new InsForgeStore(backend.make());
    const b = new InsForgeStore(backend.make());
    await a.init();
    await b.init();

    const [claimedA, claimedB] = await Promise.all([
      a.claimDeliveries(ids, { claimId: 'A', claimedAt: new Date().toISOString() }),
      b.claimDeliveries(ids, { claimId: 'B', claimedAt: new Date().toISOString() }),
    ]);
    const overlap = claimedA.filter((id) => claimedB.includes(id));
    expect(overlap).toEqual([]);
    expect(claimedA.length + claimedB.length).toBe(20);
    const remote = backend.current();
    for (const delivery of remote.deliveries) {
      expect(delivery.status).toBe('sending');
      expect(delivery.claimId).toBe(claimedA.includes(delivery.id) ? 'A' : 'B');
    }
  });
});

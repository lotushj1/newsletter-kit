import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { InsForgeBackend } from '../src/core/insforge.js';
import { platformRequest } from '../src/email/adapters/http-platform.js';
import { createInsForgeAdapter } from '../src/email/adapters/insforge.js';
import { createResendAdapter } from '../src/email/adapters/resend.js';
import { createWebhookAdapter } from '../src/email/adapters/webhook.js';
import { createZeaburAdapter } from '../src/email/adapters/zeabur.js';
import { providerLimitationWarnings } from '../src/email/providers.js';
import { withEmailHeaders } from '../src/email/headers.js';
import type { EmailMessage } from '../src/email/types.js';
import { createCampaign } from '../src/services/campaigns.js';
import { sendCampaignToSubscriber, sequenceDeliveryId } from '../src/services/sending.js';
import { publicSession } from '../src/services/session.js';
import { createSubscriber } from '../src/services/subscribers.js';
import { InsForgeStore } from '../src/store/insforge-store.js';
import { InsForgeTableStore } from '../src/store/insforge-table-store.js';
import { JsonStore } from '../src/store/json-store.js';
import type { MemorySnapshot } from '../src/store/memory-store.js';
import { MemoryStore } from '../src/store/memory-store.js';
import { SqliteStore } from '../src/store/sqlite-store.js';
import type { Delivery, Store } from '../src/store/types.js';
import { fakeAdapter, makeContext, testConfig } from './helpers.js';
import { PgliteTableDb } from './support/pglite-table-db.js';

const message: EmailMessage = withEmailHeaders({
  to: 'reader@example.com',
  from: 'News <news@example.com>',
  subject: '你好',
  html: '<p>嗨</p>',
  text: '嗨',
  unsubscribeUrl: 'https://newsletter.test/unsubscribe?token=abc',
  idempotencyKey: 'dlv_0001',
});

const originalFetch = globalThis.fetch;
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  globalThis.fetch = originalFetch;
  for (const fn of cleanups.splice(0)) await fn();
});

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function stubFetch(status = 200, body: unknown = { id: 'msg_1' }): Captured[] {
  const calls: Captured[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return calls;
}

describe('冪等鍵（寄送紀錄 id）', () => {
  it('Resend 帶 Idempotency-Key 標頭', async () => {
    const calls = stubFetch();
    const result = await createResendAdapter({ provider: 'resend', resendApiKey: 're_test' }).send(message);
    expect(result.ok).toBe(true);
    expect(calls[0]!.headers['idempotency-key']).toBe('dlv_0001');
  });

  it('Resend 回 409（同一把鍵還在處理或內容不同）時當成結果不明，不重寄', async () => {
    stubFetch(409, { name: 'concurrent_idempotent_requests' });
    const result = await createResendAdapter({ provider: 'resend', resendApiKey: 're_test' }).send(message);
    expect(result).toMatchObject({ ok: false, outcomeUnknown: true, retryable: false });
  });

  it('沒有冪等鍵的測試信不帶標頭', async () => {
    const calls = stubFetch();
    await createResendAdapter({ provider: 'resend', resendApiKey: 're_test' }).send({ ...message, idempotencyKey: undefined });
    expect(calls[0]!.headers['idempotency-key']).toBeUndefined();
  });

  it('Webhook 與 Zeabur 把冪等鍵交給你的端點（內文與標頭）', async () => {
    const calls = stubFetch();
    await createWebhookAdapter({ provider: 'webhook', webhookUrl: 'https://relay.test/send' }).send(message);
    await createZeaburAdapter({ provider: 'zeabur', zeaburEndpoint: 'https://relay.test/send' }).send(message);
    for (const call of calls) {
      expect(call.body.idempotencyKey).toBe('dlv_0001');
      expect(call.headers['idempotency-key']).toBe('dlv_0001');
    }
  });
});

describe('純文字版本與標頭', () => {
  it('Elastic Email 帶純文字版本', () => {
    const request = platformRequest('elasticemail', { apiKey: 'key' }, message);
    if (!('body' in request)) throw new Error('expected body');
    const body = JSON.parse(request.body) as { Content: { Body: { ContentType: string; Content: string }[]; Headers: Record<string, string> } };
    expect(body.Content.Body).toEqual([
      { ContentType: 'HTML', Content: '<p>嗨</p>', Charset: 'utf-8' },
      { ContentType: 'PlainText', Content: '嗨', Charset: 'utf-8' },
    ]);
    expect(body.Content.Headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  it('Elastic Email 沒有純文字時只送 HTML', () => {
    const request = platformRequest('elasticemail', { apiKey: 'key' }, { ...message, text: undefined });
    if (!('body' in request)) throw new Error('expected body');
    expect((JSON.parse(request.body) as { Content: { Body: unknown[] } }).Content.Body).toHaveLength(1);
  });

  it('做不到的管道會在啟動 log 與後台設定頁警告', async () => {
    expect(providerLimitationWarnings('insforge').join('\n')).toMatch(/List-Unsubscribe[\s\S]*純文字/);
    expect(providerLimitationWarnings('plunk').join('\n')).toContain('純文字');
    expect(providerLimitationWarnings('ses').join('\n')).toContain('寄不出去');
    expect(providerLimitationWarnings('resend')).toEqual([]);
    expect(providerLimitationWarnings('dry_run')).toEqual([]);

    const { ctx } = await makeContext();
    expect(publicSession(ctx).warnings).toEqual([]);
    ctx.config.email.provider = 'insforge';
    expect(publicSession(ctx).warnings.some((w) => w.includes('InsForge') && w.includes('List-Unsubscribe'))).toBe(true);
    const verify = await createInsForgeAdapter({ provider: 'insforge', insforgeUrl: 'https://x.test', insforgeApiKey: 'k' }).verify();
    expect(verify.message).toContain('List-Unsubscribe');
  });
});

function fakeSnapshotBackend(): InsForgeBackend {
  let current: MemorySnapshot | null = null;
  return {
    async loadSnapshot() {
      return current ? structuredClone(current) : null;
    },
    async saveSnapshot(snapshot) {
      current = structuredClone(snapshot);
    },
    async createSnapshot(snapshot) {
      current = structuredClone(snapshot);
    },
    async snapshotExists() {
      return current !== null;
    },
    async uploadImage(fileName) {
      return { url: `https://files.example/${fileName}` };
    },
    async sendEmail() {
      return { id: 'msg_1' };
    },
  };
}

/** [名稱, 開一個 store, 用同一份資料重開一個 store]。 */
type Factory = () => Promise<{ open: () => Promise<Store>; reopen: () => Promise<Store> }>;
const factories: [string, Factory][] = [
  ['memory', async () => {
    const store = new MemoryStore();
    return { open: async () => store, reopen: async () => store };
  }],
  ['sqlite', async () => {
    const path = join(tmpdir(), `nk-receipts-${randomUUID()}.db`);
    cleanups.push(() => rmSync(path, { force: true }));
    return { open: async () => new SqliteStore(path), reopen: async () => new SqliteStore(path) };
  }],
  ['json', async () => {
    const path = join(tmpdir(), `nk-receipts-${randomUUID()}.json`);
    cleanups.push(() => rmSync(path, { force: true }));
    return { open: async () => new JsonStore(path), reopen: async () => new JsonStore(path) };
  }],
  ['insforge', async () => {
    const backend = fakeSnapshotBackend();
    return { open: async () => new InsForgeStore(backend), reopen: async () => new InsForgeStore(backend) };
  }],
  ['insforge-tables', async () => {
    const db = await PgliteTableDb.create();
    cleanups.push(() => db.close());
    return { open: async () => new InsForgeTableStore(db), reopen: async () => new InsForgeTableStore(db) };
  }],
];

describe.each(factories)('寄送紀錄的回報與對帳欄位（%s）', { timeout: 60_000 }, (_name, factory) => {
  it('寫入、讀回、重開後都還在；跨電子報依狀態列出', async () => {
    const { open, reopen } = await factory();
    const store = await open();
    await store.init();
    const base = { subscriberId: 'sub_1', email: 'r@example.test', attempts: 1 } as const;
    await store.createDeliveries([
      { ...base, id: 'dlv_a', campaignId: 'cmp_1', status: 'pending' },
      { ...base, id: 'dlv_b', campaignId: 'cmp_2', status: 'pending' },
      { ...base, id: 'dlv_c', campaignId: 'cmp_2', status: 'sent', receipt: 'delivered', receiptAt: '2026-11-20T00:00:00.000Z' },
    ]);
    expect(await store.claimDeliveries(['dlv_a', 'dlv_b'], { claimId: 'clm_1', claimedAt: '2026-11-20T01:00:00.000Z' })).toHaveLength(2);
    const reconcile = { at: '2026-11-20T02:00:00.000Z', by: 'admin@example.test', result: 'not_found' as const, note: '查不到' };
    expect(await store.updateDeliveries([{ id: 'dlv_a', patch: { reconcile } }])).toBe(1);
    await store.updateDelivery('dlv_b', { status: 'failed', receipt: 'bounced', receiptAt: '2026-11-20T03:00:00.000Z' });

    const check = async (s: Store) => {
      expect(await s.getDelivery('dlv_a')).toMatchObject({ status: 'sending', reconcile });
      expect(await s.getDelivery('dlv_b')).toMatchObject({ status: 'failed', receipt: 'bounced', receiptAt: '2026-11-20T03:00:00.000Z' });
      expect(await s.getDelivery('dlv_c')).toMatchObject({ receipt: 'delivered' });
      expect(await s.getDelivery('dlv_missing')).toBeNull();
      expect((await s.listDeliveriesByStatus('sending')).map((d: Delivery) => d.id)).toEqual(['dlv_a']);
      expect((await s.listDeliveriesByStatus('failed')).map((d: Delivery) => d.id)).toEqual(['dlv_b']);
      expect(await s.listDeliveriesByStatus('sent', { limit: 1 })).toHaveLength(1);
    };
    await check(store);
    const again = await reopen();
    await again.init();
    await check(again);
    await store.close();
    if (again !== store) await again.close();
  });
});

describe('序列信在逐表 store（InsForge 正式環境）的併發保護', () => {
  it('兩個程序同時處理同一個入隊步驟，只會寄出一封', async () => {
    const db = await PgliteTableDb.create();
    cleanups.push(() => db.close());
    const store = new InsForgeTableStore(db);
    await store.init();
    const adapter = fakeAdapter();
    const ctx = { config: testConfig(), store, adapter, ai: null };
    const campaign = await createCampaign(ctx, { title: '歡迎', bodyHtml: '<p>嗨</p>' });
    const subscriber = await createSubscriber(ctx, { email: 'race@example.test' });
    const deliveryId = sequenceDeliveryId('enr_race', 0);

    const results = await Promise.all([
      sendCampaignToSubscriber(ctx, campaign, subscriber, { deliveryId }),
      sendCampaignToSubscriber(ctx, campaign, subscriber, { deliveryId }),
    ]);
    expect(adapter.sent).toHaveLength(1);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await store.getDelivery(deliveryId)).toMatchObject({ status: 'sent', receipt: 'accepted' });
  });
});

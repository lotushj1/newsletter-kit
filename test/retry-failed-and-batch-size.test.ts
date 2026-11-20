import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BATCH_MAX_BYTES, chunkBySize, createPortalyAdapter } from '../src/email/adapters/portaly.js';
import type { EmailMessage } from '../src/email/types.js';
import { createCampaign } from '../src/services/campaigns.js';
import { startCampaign } from '../src/services/sending.js';
import { createSubscriber } from '../src/services/subscribers.js';
import { makeContext } from './helpers.js';

describe('已寄出但有失敗的電子報：只重寄失敗的收件人', () => {
  async function seed() {
    const { ctx, adapter } = await makeContext({ doubleOptIn: false });
    for (const email of ['a@example.com', 'b@example.com', 'c@example.com']) {
      await createSubscriber(ctx, { email });
    }
    const campaign = await createCampaign(ctx, { title: '週報', bodyMarkdown: '內容' });
    // 第一次寄：只有 a 成功，其餘被供應商整批拒收（例如 413）
    adapter.behavior = (message) =>
      message.to === 'a@example.com' ? null : { ok: false, error: 'Portaly 413', retryable: false };
    await startCampaign(ctx, campaign.id);
    return { ctx, adapter, campaignId: campaign.id };
  }

  it('第一次寄完狀態是已寄出，但記得失敗的人', async () => {
    const { ctx, campaignId } = await seed();
    expect((await ctx.store.getCampaign(campaignId))?.status).toBe('sent');
    expect(await ctx.store.deliveryStats(campaignId)).toMatchObject({ total: 3, sent: 1, failed: 2 });
  });

  it('重寄時只寄給失敗的人，已收到的不會收到第二封', async () => {
    const { ctx, adapter, campaignId } = await seed();
    adapter.sent.length = 0;
    adapter.behavior = () => null;
    await startCampaign(ctx, campaignId);
    expect(adapter.sent.map((m) => m.to).sort()).toEqual(['b@example.com', 'c@example.com']);
    expect(await ctx.store.deliveryStats(campaignId)).toMatchObject({ total: 3, sent: 3, failed: 0 });
    expect((await ctx.store.getCampaign(campaignId))?.status).toBe('sent');
  });

  it('全部都寄出後，再按寄送仍然拒絕', async () => {
    const { ctx, adapter, campaignId } = await seed();
    adapter.behavior = () => null;
    await startCampaign(ctx, campaignId);
    await expect(startCampaign(ctx, campaignId)).rejects.toThrow('已經寄過了');
  });
});

describe('Portaly 依大小切批', () => {
  it('chunkBySize 同時守筆數與大小上限，順序不變', () => {
    const items = [5, 5, 5, 5, 9, 1, 1];
    expect(chunkBySize(items, (n) => n, 3, 10)).toEqual([[5, 5], [5, 5], [9, 1], [1]]);
    expect(chunkBySize(items, (n) => n, 2, 100)).toEqual([[5, 5], [5, 5], [9, 1], [1]]);
    // 單筆就超過上限時自成一批
    expect(chunkBySize([50, 1], (n) => n, 10, 10)).toEqual([[50], [1]]);
  });

  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('大封信件分成多個請求，每個請求都在上限內，結果照原順序對回', async () => {
    const bodies: number[] = [];
    let call = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const raw = String(init?.body ?? '');
      bodies.push(Buffer.byteLength(raw, 'utf8'));
      call += 1;
      const count = (JSON.parse(raw) as { emails: unknown[] }).emails.length;
      return new Response(
        JSON.stringify({ data: { emails: Array.from({ length: count }, (_, i) => ({ id: `m${call}_${i}` })) } }),
        { status: 202, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    const big = '<p>' + '內容'.repeat(10_000) + '</p>'; // 每封約 60 KB
    const messages: EmailMessage[] = Array.from({ length: 100 }, (_, i) => ({
      to: `r${i}@example.com`,
      from: 'News <news@example.com>',
      subject: '週報',
      html: big,
      text: '內容',
      idempotencyKey: `dlv_${i}`,
    }));
    const adapter = createPortalyAdapter({ provider: 'portaly', portalyApiKey: 'pem_test_key' });
    const results = await adapter.sendBatch!(messages);
    expect(results).toHaveLength(100);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(bodies.length).toBeGreaterThan(1);
    for (const size of bodies) expect(size).toBeLessThanOrEqual(BATCH_MAX_BYTES + 10_000);
    expect(results[0]).toEqual({ ok: true, id: 'm1_0' });
  });
});

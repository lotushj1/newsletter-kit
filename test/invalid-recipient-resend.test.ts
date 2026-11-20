import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { batchIdempotencyKey, createPortalyAdapter, invalidRecipientIndexes } from '../src/email/adapters/portaly.js';
import type { EmailMessage } from '../src/email/types.js';
import { createCampaign } from '../src/services/campaigns.js';
import { startCampaign } from '../src/services/sending.js';
import { createSubscriber } from '../src/services/subscribers.js';
import { makeContext } from './helpers.js';

const base: EmailMessage = {
  to: 'a@example.com',
  from: 'News <news@example.com>',
  subject: '週報',
  html: '<p>內容</p>',
  text: '內容',
  idempotencyKey: 'dlv_a',
};

describe('invalidRecipientIndexes', () => {
  it('只解析 400 INVALID_BODY 的收件地址錯誤', () => {
    const err = (message: string, status = 400, code = 'INVALID_BODY') => ({ status, code, message });
    expect(invalidRecipientIndexes(err('emails.2.recipients.0.email: Invalid email address'), 17)).toEqual([2]);
    expect(invalidRecipientIndexes(err('emails.5.recipients.0.email: x; emails.1.recipients.0.email: y'), 17)).toEqual([1, 5]);
    expect(invalidRecipientIndexes(err('emails.20.recipients.0.email: x'), 17)).toEqual([]);
    expect(invalidRecipientIndexes(err('subject: Required'), 17)).toEqual([]);
    expect(invalidRecipientIndexes(err('emails.2.recipients.0.email: x', 413, 'PAYLOAD_TOO_LARGE'), 17)).toEqual([]);
  });
});

describe('批次裡有格式不合格的地址', () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('只有那一封失敗，其餘換新的批次冪等鍵重送一次，結果照原順序對回', async () => {
    const calls: { to: string[]; key: string }[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { emails: { recipients: { email: string }[] }[] };
      const to = body.emails.map((e) => e.recipients[0]!.email);
      calls.push({ to, key: new Headers(init?.headers).get('idempotency-key') ?? '' });
      const bad = to.indexOf('not-an-email');
      if (bad >= 0) {
        return new Response(
          JSON.stringify({ error: { code: 'INVALID_BODY', message: `emails.${bad}.recipients.0.email: Invalid email address` } }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ data: { emails: to.map((t) => ({ id: `id_${t}` })) } }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const messages: EmailMessage[] = [
      base,
      { ...base, to: 'not-an-email', idempotencyKey: 'dlv_bad' },
      { ...base, to: 'c@example.com', idempotencyKey: 'dlv_c' },
    ];
    const adapter = createPortalyAdapter({ provider: 'portaly', portalyApiKey: 'pem_test_key' });
    const results = await adapter.sendBatch!(messages);

    expect(results[0]).toEqual({ ok: true, id: 'id_a@example.com' });
    expect(results[1]).toMatchObject({ ok: false, retryable: false });
    expect(results[2]).toEqual({ ok: true, id: 'id_c@example.com' });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.to).toEqual(['a@example.com', 'c@example.com']);
    expect(calls[1]!.key).toBe(batchIdempotencyKey(['dlv_a', 'dlv_c']));
    expect(calls[1]!.key).not.toBe(calls[0]!.key);
  });
});

describe('補寄不會重複寄送', () => {
  it('只重寄「寄信服務沒收下」的失敗；收下後才退信的不重寄，已寄出的也不重寄', async () => {
    const { ctx, adapter } = await makeContext({ doubleOptIn: false });
    for (const email of ['ok@example.com', 'rejected@example.com', 'bounced@example.com']) {
      await createSubscriber(ctx, { email });
    }
    const campaign = await createCampaign(ctx, { title: '週報', bodyMarkdown: '內容' });
    adapter.behavior = (message) =>
      message.to === 'rejected@example.com' ? { ok: false, error: 'Portaly 400: INVALID_BODY', retryable: false } : null;
    await startCampaign(ctx, campaign.id);

    // 寄信服務事後回報 bounced@ 退信：狀態改成失敗，但保留寄信服務的信件編號
    const all = await ctx.store.listDeliveries(campaign.id);
    const bounced = all.find((d) => d.email === 'bounced@example.com')!;
    expect(bounced.providerMessageId).toBeTruthy();
    await ctx.store.updateDelivery(bounced.id, { status: 'failed', error: '硬退信' });

    adapter.sent.length = 0;
    adapter.behavior = () => null;
    await startCampaign(ctx, campaign.id);
    expect(adapter.sent.map((m) => m.to)).toEqual(['rejected@example.com']);
    expect(await ctx.store.deliveryStats(campaign.id)).toMatchObject({ sent: 2, failed: 1 });
  });
});

import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/http/app.js';
import { createCampaign } from '../src/services/campaigns.js';
import { previewRecipients, startCampaign } from '../src/services/sending.js';
import { createSubscriber } from '../src/services/subscribers.js';
import { makeContext } from './helpers.js';

describe('寄送確認：實際收件人數與排除人數', () => {
  it('依受眾條件：扣掉排除名單上的人，排除人數另外算', async () => {
    const { ctx, store } = await makeContext();
    await createSubscriber(ctx, { email: 'a@example.com', tags: ['vip'] });
    await createSubscriber(ctx, { email: 'b@example.com', tags: ['vip'] });
    const bounced = await createSubscriber(ctx, { email: 'c@example.com', tags: ['vip'] });
    await createSubscriber(ctx, { email: 'd@example.com' });
    await store.updateSubscriber(bounced.id, { meta: { suppressedReason: 'bounce' } });
    const campaign = await createCampaign(ctx, { title: 't', bodyMarkdown: '嗨', audienceTags: ['vip'] });

    expect(await previewRecipients(ctx, campaign)).toEqual({ mode: 'audience', count: 2, excluded: 1 });
    // 跟真正寄送的人數一致
    expect((await startCampaign(ctx, campaign.id)).total).toBe(2);
  });

  it('寄過但有失敗：只算會補寄的人，已寄出的不算', async () => {
    const { ctx, adapter } = await makeContext();
    await createSubscriber(ctx, { email: 'a@example.com' });
    await createSubscriber(ctx, { email: 'b@example.com' });
    await createSubscriber(ctx, { email: 'c@example.com' });
    adapter.behavior = (message) => (message.to === 'b@example.com' ? { ok: false, error: '拒收', retryable: false } : null);
    const campaign = await createCampaign(ctx, { title: 't', bodyMarkdown: '嗨' });
    await startCampaign(ctx, campaign.id);
    const after = await ctx.store.getCampaign(campaign.id);
    expect(after?.status).toBe('sent');

    expect(await previewRecipients(ctx, after!)).toEqual({ mode: 'resend', count: 1, excluded: 0 });
  });

  it('預覽收件人數 API 一併回傳排除人數與模式', async () => {
    const { ctx, store } = await makeContext();
    await createSubscriber(ctx, { email: 'a@example.com' });
    const suppressed = await createSubscriber(ctx, { email: 'b@example.com' });
    await store.updateSubscriber(suppressed.id, { meta: { suppressedReason: 'complaint' } });
    const campaign = await createCampaign(ctx, { title: 't', bodyMarkdown: '嗨' });
    const server = createApp(ctx).listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/admin/campaigns/${campaign.id}/audience-count`, {
        method: 'POST',
        headers: { authorization: 'Bearer test-admin-token', 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(await res.json()).toEqual({ count: 1, excluded: 1, mode: 'audience' });
    } finally {
      server.close();
    }
  });
});

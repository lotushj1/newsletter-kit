import { describe, expect, it } from 'vitest';
import { createCampaign, overviewRates } from '../src/services/campaigns.js';
import { startCampaign } from '../src/services/sending.js';
import { createSubscriber, unsubscribeByEmail } from '../src/services/subscribers.js';
import { makeContext } from './helpers.js';

describe('總覽區間統計', () => {
  it('只計算區間內的新增訂閱與退訂', async () => {
    const { store } = await makeContext({ doubleOptIn: false });
    await store.createSubscriber({
      id: 'sub_old',
      email: 'old@example.com',
      status: 'subscribed',
      tags: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      confirmedAt: '2026-01-01T00:00:00.000Z',
    });
    await store.createSubscriber({
      id: 'sub_new',
      email: 'new@example.com',
      status: 'subscribed',
      tags: [],
      createdAt: '2026-09-10T00:00:00.000Z',
      confirmedAt: '2026-09-10T00:00:00.000Z',
    });
    await store.createSubscriber({
      id: 'sub_left',
      email: 'left@example.com',
      status: 'unsubscribed',
      tags: [],
      createdAt: '2026-08-01T00:00:00.000Z',
      unsubscribedAt: '2026-09-11T12:00:00.000Z',
    });

    const stats = await store.periodStats({
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-30T23:59:59.000Z',
    });
    expect(stats.newSubscribers).toBe(1);
    expect(stats.unsubscribes).toBe(1);
    expect(stats.sent).toBe(0);
  });

  it('寄出後退訂會算進該封電子報', async () => {
    const { ctx } = await makeContext({ doubleOptIn: false });
    await createSubscriber(ctx, { email: 'a@example.com', status: 'subscribed' });
    await createSubscriber(ctx, { email: 'b@example.com', status: 'subscribed' });
    const campaign = await createCampaign(ctx, { title: '九月刊', bodyHtml: '<p>內容</p>' });
    await startCampaign(ctx, campaign.id);
    await unsubscribeByEmail(ctx, 'a@example.com');

    const updated = await ctx.store.getCampaign(campaign.id);
    expect(updated?.tracking.unsubscribes).toBe(1);

    const rates = await overviewRates(ctx);
    expect(rates.sent).toBe(2);
    expect(rates.sentCampaigns).toBe(1);
    expect(rates.unsubscribes).toBe(1);
  });
});

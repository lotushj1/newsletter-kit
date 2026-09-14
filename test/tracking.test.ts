import { describe, expect, it } from 'vitest';
import { injectTracking } from '../src/core/tracking.js';
import { createCampaign } from '../src/services/campaigns.js';
import { startCampaign, sendTestEmail } from '../src/services/sending.js';
import { createSubscriber } from '../src/services/subscribers.js';
import { recordClick, recordOpen } from '../src/services/tracking.js';
import { makeContext } from './helpers.js';

describe('開信與點擊追蹤', () => {
  it('正式寄送會注入 pixel 與轉址，測試信不會', async () => {
    const { ctx, adapter } = await makeContext();
    await createSubscriber(ctx, { email: 'a@example.com' });
    const campaign = await createCampaign(ctx, {
      title: 't',
      bodyHtml: '<p>看 <a href="https://example.com/post">這篇</a></p>',
    });

    await startCampaign(ctx, campaign.id);
    const sent = adapter.sent[0]!;
    expect(sent.html).toContain('/t/open?token=');
    expect(sent.html).toContain('/t/click?token=');
    expect(sent.html).not.toContain('href="https://example.com/post"');

    const before = adapter.sent.length;
    await sendTestEmail(ctx, campaign.id, 'tester@example.com');
    expect(adapter.sent[before]!.html).not.toContain('/t/open?token=');
    expect(adapter.sent[before]!.html).toContain('https://example.com/post');
  });

  it('TRACKING_ENABLED=false 時不注入', async () => {
    const { ctx, adapter } = await makeContext({ trackingEnabled: false });
    await createSubscriber(ctx, { email: 'a@example.com' });
    const campaign = await createCampaign(ctx, {
      title: 't',
      bodyHtml: '<p><a href="https://example.com">x</a></p>',
    });
    await startCampaign(ctx, campaign.id);
    expect(adapter.sent[0]!.html).not.toContain('/t/open?token=');
    expect(adapter.sent[0]!.html).toContain('https://example.com');
  });

  it('pixel 與轉址會記入 events', async () => {
    const { ctx } = await makeContext();
    const html = injectTracking('<body><a href="https://example.com/a">a</a></body>', {
      secret: ctx.config.appSecret,
      publicBaseUrl: ctx.config.publicBaseUrl,
      email: 'a@example.com',
      campaignId: 'cmp_1',
      deliveryId: 'dlv_1',
      subscriberId: 'sub_1',
    });
    const openToken = /\/t\/open\?token=([^"&]+)/.exec(html)?.[1];
    const clickToken = /\/t\/click\?token=([^"&]+)/.exec(html)?.[1];
    expect(openToken).toBeTruthy();
    expect(clickToken).toBeTruthy();

    expect(await recordOpen(ctx, decodeURIComponent(openToken!))).toBe(true);
    expect(await recordClick(ctx, decodeURIComponent(clickToken!))).toBe('https://example.com/a');
    const stats = await ctx.store.campaignTrackingStats('cmp_1');
    expect(stats.opens).toBe(1);
    expect(stats.uniqueOpens).toBe(1);
    expect(stats.clicks).toBe(1);
  });

  it('退訂連結不會被改成轉址', () => {
    const html = injectTracking(
      '<a href="https://newsletter.test/unsubscribe?token=abc">退訂</a><a href="https://other.test">外</a>',
      {
        secret: 's',
        publicBaseUrl: 'https://newsletter.test',
        email: 'a@example.com',
        campaignId: 'c',
        deliveryId: 'd',
        subscriberId: 's1',
      },
    );
    expect(html).toContain('https://newsletter.test/unsubscribe?token=abc');
    expect(html).toContain('/t/click?token=');
  });
});

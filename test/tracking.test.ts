import { describe, expect, it } from 'vitest';
import { injectTracking } from '../src/core/tracking.js';
import { createCampaign, overviewRates } from '../src/services/campaigns.js';
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
    await ctx.store.createDeliveries([
      {
        id: 'dlv_1',
        campaignId: 'cmp_1',
        subscriberId: 'sub_1',
        email: 'a@example.com',
        status: 'sent',
        attempts: 1,
        sentAt: new Date().toISOString(),
      },
    ]);
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
    expect(stats.orphanEvents).toBe(0);
  });

  it('寄送紀錄已遺失的開信事件不算進統計，改計為 orphanEvents（避免開信率超過 100%）', async () => {
    const { ctx } = await makeContext();
    const html = injectTracking('<body><a href="https://example.com/a">a</a></body>', {
      secret: ctx.config.appSecret,
      publicBaseUrl: ctx.config.publicBaseUrl,
      email: 'lost@example.com',
      campaignId: 'cmp_1',
      deliveryId: 'dlv_lost',
      subscriberId: 'sub_lost',
    });
    const openToken = /\/t\/open\?token=([^"&]+)/.exec(html)?.[1];
    expect(await recordOpen(ctx, decodeURIComponent(openToken!))).toBe(true);
    const stats = await ctx.store.campaignTrackingStats('cmp_1');
    expect(stats.uniqueOpens).toBe(0);
    expect(stats.orphanEvents).toBe(1);
    const period = await ctx.store.periodStats({});
    expect(period.uniqueOpens).toBe(0);
    expect(period.orphanEvents).toBe(1);
    const rates = await overviewRates(ctx, {});
    expect(rates.dataIncomplete).toBe(true);
    expect(rates.openRate).toBeNull();
  });

  it('連結查詢字串裡的 &amp; 會解碼，轉址導向正確網址（含已寄出的舊 token）', async () => {
    const { ctx } = await makeContext();
    const html = injectTracking(
      '<a href="https://example.com/a?x=1&amp;utm_source=newsletter&amp;utm_medium=email">a</a>',
      { secret: ctx.config.appSecret, publicBaseUrl: ctx.config.publicBaseUrl, email: 'a@example.com', campaignId: 'cmp_1', deliveryId: 'dlv_1', subscriberId: 'sub_1' },
    );
    const clickToken = /\/t\/click\?token=([^"&]+)/.exec(html)?.[1];
    expect(await recordClick(ctx, decodeURIComponent(clickToken!))).toBe(
      'https://example.com/a?x=1&utm_source=newsletter&utm_medium=email',
    );
    // 舊版已簽進 token 的 &amp; 網址，轉址時也會修正
    const { createTrackingToken } = await import('../src/core/tokens.js');
    const legacy = createTrackingToken(ctx.config.appSecret, {
      purpose: 'click', email: 'a@example.com', campaignId: 'cmp_1', deliveryId: 'dlv_1', subscriberId: 'sub_1',
      url: 'https://www.youtube.com/watch?v=abc&amp;utm_source=newsletter',
    });
    expect(await recordClick(ctx, legacy)).toBe('https://www.youtube.com/watch?v=abc&utm_source=newsletter');
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

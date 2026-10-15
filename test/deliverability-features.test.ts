import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/http/app.js';
import { createToken } from '../src/core/tokens.js';
import { emailHeaders } from '../src/email/headers.js';
import { platformRequest } from '../src/email/adapters/http-platform.js';
import { portalyEmailPayload } from '../src/email/adapters/portaly.js';
import { EMAIL_PLATFORMS } from '../src/email/providers.js';
import { createCampaign, renderCampaign, updateCampaign } from '../src/services/campaigns.js';
import { updateBrand } from '../src/services/brand.js';
import { selectAudience } from '../src/services/audience.js';
import { campaignLinkStats } from '../src/services/link-stats.js';
import { startCampaign } from '../src/services/sending.js';
import { applyProviderProblem } from '../src/services/suppression.js';
import { makeContext, testConfig } from './helpers.js';
import { JsonStore } from '../src/store/json-store.js';

const message = { to: 'a@example.com', from: 'News <hi@example.com>', subject: 'Hello', html: '<p>Hello</p>', unsubscribeUrl: 'https://newsletter.test/unsubscribe?token=abc', unsubscribeMailto: 'leave@example.com' };

it('builds RFC 8058 headers and maps them through every HTTP platform payload', () => {
  const headers = emailHeaders(message);
  expect(headers).toEqual({ 'List-Unsubscribe': '<https://newsletter.test/unsubscribe?token=abc>, <mailto:leave@example.com>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' });
  for (const platform of EMAIL_PLATFORMS.filter((item) => item.kind === 'http')) {
    const request = platformRequest(platform.id, { apiKey: 'key', apiExtra: platform.id === 'postal' ? 'https://postal.test' : 'example.com' }, message);
    expect(request, platform.id).toHaveProperty('body');
    if ('body' in request) {
      expect(request.body, platform.id).toContain('List-Unsubscribe');
      expect(request.body, platform.id).toContain('List-Unsubscribe-Post');
    }
  }
  expect(portalyEmailPayload(message, 'dlv_1').headers).toMatchObject(headers);
});

it('one-click POST unsubscribes without cookies, preserves GET confirmation, and is idempotent', async () => {
  const { ctx, store } = await makeContext();
  await store.createSubscriber({ id: 'sub_one', email: 'one@example.com', status: 'subscribed', tags: [], createdAt: new Date().toISOString() });
  const server = createApp(ctx).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const token = createToken(ctx.config.appSecret, 'unsubscribe', 'one@example.com');
    const path = `/unsubscribe?token=${encodeURIComponent(token)}`;
    expect((await fetch(base + path)).status).toBe(200);
    expect((await store.getSubscriberByEmail('one@example.com'))?.status).toBe('subscribed');
    for (let i = 0; i < 2; i++) {
      const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
      expect(response.status).toBe(200);
    }
    expect((await store.getSubscriberByEmail('one@example.com'))?.status).toBe('unsubscribed');
    expect((await fetch(base + '/unsubscribe?token=bad', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' })).status).toBe(400);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

it('renders address and privacy URL in built-in layout and custom variables, with empty values omitted', async () => {
  const { ctx } = await makeContext({ physicalAddress: '', privacyUrl: '' });
  const campaign = await createCampaign(ctx, { title: 'Hello', bodyHtml: '<p>{{physical_address}} {{privacy_url}}</p>' });
  let rendered = await renderCampaign(ctx, campaign, { email: 'one@example.com' });
  expect(rendered.html).not.toContain('隱私權政策');
  expect(rendered.html).not.toContain('Taipei Road');
  await updateBrand(ctx, { physicalAddress: '1 Taipei Road', privacyUrl: 'https://example.com/privacy' });
  rendered = await renderCampaign(ctx, campaign, { email: 'one@example.com' });
  expect(rendered.html).toContain('1 Taipei Road');
  expect(rendered.html).toContain('https://example.com/privacy');
  expect(rendered.html).toContain('隱私權政策');
});

it('uses environment footer values until admin settings override them', async () => {
  const { ctx } = await makeContext({ physicalAddress: 'Env street', privacyUrl: 'https://env.example/privacy' });
  const campaign = await createCampaign(ctx, { title: 'Env', bodyHtml: '<p>Hi</p>' });
  expect((await renderCampaign(ctx, campaign, { email: 'a@example.com' })).html).toContain('Env street');
  await updateBrand(ctx, { physicalAddress: '', privacyUrl: '' });
  const html = (await renderCampaign(ctx, campaign, { email: 'a@example.com' })).html;
  expect(html).not.toContain('Env street');
  expect(html).not.toContain('隱私權政策');
});

it('evaluates legacy tags and folder plus AND, OR, NOT, dates, opens, and URL clicks', async () => {
  const { ctx, store } = await makeContext();
  const now = new Date().toISOString();
  await store.createFolder({ id: 'folder1', name: 'One', kind: 'subscribers', createdAt: now });
  await store.createFolder({ id: 'folder2', name: 'Two', kind: 'subscribers', createdAt: now });
  for (const [id, tags, folderId] of [['a', ['vip'], 'folder1'], ['b', ['vip'], 'folder2'], ['c', ['other'], 'folder1']] as const) {
    await store.createSubscriber({ id, email: `${id}@example.com`, status: 'subscribed', tags: [...tags], folderId, createdAt: now });
  }
  await store.createEvent({ id: 'o1', campaignId: 'past', subscriberId: 'a', type: 'open', createdAt: now });
  await store.createEvent({ id: 'c1', campaignId: 'past', subscriberId: 'b', type: 'click', url: 'https://example.com/article', createdAt: now });
  await store.createEvent({ id: 'old', campaignId: 'past', subscriberId: 'c', type: 'open', createdAt: '2020-01-01T00:00:00.000Z' });
  const campaign = await createCampaign(ctx, { title: 'Segment', audienceTags: ['vip'], audienceFolderId: 'folder1' });
  expect((await selectAudience(ctx, campaign)).map((s) => s.id)).toEqual(['a']);
  const complex = await updateCampaign(ctx, campaign.id, { audienceTags: [], audienceFolderId: '', audienceCondition: { op: 'and', children: [
    { op: 'or', children: [{ op: 'engagement', event: 'open', campaignId: 'past', withinDays: 30 }, { op: 'engagement', event: 'click', withinDays: 30, url: 'https://example.com/article' }] },
    { op: 'not', child: { op: 'folder', folderId: 'folder2' } },
    { op: 'created', after: '2025-01-01' },
  ] } });
  expect((await selectAudience(ctx, complex)).map((s) => s.id)).toEqual(['a']);
  const inactive = await updateCampaign(ctx, campaign.id, { audienceCondition: { op: 'not', child: { op: 'engagement', event: 'open', withinDays: 90 } } });
  expect((await selectAudience(ctx, inactive)).map((s) => s.id)).toEqual(['b', 'c']);
  await applyProviderProblem(ctx, { email: 'b@example.com', reason: 'complaint', provider: 'test' });
  expect((await selectAudience(ctx, inactive)).map((s) => s.id)).toEqual(['c']);
});

it('counts total and unique clicks per normalized URL sorted by clicks', async () => {
  const { ctx, store } = await makeContext();
  const events = [
    ['1', 'a', 'https://EXAMPLE.com:443/article'], ['2', 'a', 'https://example.com/article'],
    ['3', 'b', 'https://example.com/article'], ['4', 'b', 'https://example.com/other'],
  ];
  for (const [id, subscriberId, url] of events) await store.createEvent({ id, campaignId: 'campaign', subscriberId, type: 'click', url, createdAt: new Date().toISOString() });
  expect(await campaignLinkStats(ctx, 'campaign')).toEqual([
    { url: 'https://example.com/article', clicks: 3, uniqueClicks: 2 },
    { url: 'https://example.com/other', clicks: 1, uniqueClicks: 1 },
  ]);
});

it('passes one-click headers through the campaign pipeline and skips suppressed addresses', async () => {
  const { ctx, store, adapter } = await makeContext({ email: { ...testConfig().email, unsubscribeMailto: 'leave@example.com' } });
  await store.createSubscriber({ id: 'a', email: 'a@example.com', status: 'subscribed', tags: [], createdAt: new Date().toISOString() });
  await store.createSubscriber({ id: 'b', email: 'b@example.com', status: 'subscribed', tags: [], createdAt: new Date().toISOString() });
  await applyProviderProblem(ctx, { email: 'b@example.com', reason: 'bounce', provider: 'test' });
  const campaign = await createCampaign(ctx, { title: 'Send', bodyHtml: '<p>Hello</p>' });
  await startCampaign(ctx, campaign.id);
  expect(adapter.sent).toHaveLength(1);
  expect(adapter.sent[0]?.headers).toEqual({
    'List-Unsubscribe': expect.stringContaining('<mailto:leave@example.com>'),
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  });
});

for (const Driver of [JsonStore]) {
  it(`${Driver.name} retains condition trees, events, and suppression after reopening`, async () => {
    const folder = mkdtempSync(join(tmpdir(), 'newsletter-deliverability-'));
    const path = join(folder, 'store.json');
    const made = await makeContext();
    let store = new Driver(path);
    try {
      await store.init();
      made.ctx.store = store;
      await store.createSubscriber({ id: 'one', email: 'one@example.com', status: 'subscribed', tags: ['vip'], createdAt: new Date().toISOString() });
      const campaign = await createCampaign(made.ctx, { title: 'Persist', audienceCondition: { op: 'tag', tag: 'vip' } });
      await store.createEvent({ id: 'click1', campaignId: campaign.id, subscriberId: 'one', type: 'click', url: 'https://example.com', createdAt: new Date().toISOString() });
      await applyProviderProblem(made.ctx, { email: 'one@example.com', reason: 'bounce', provider: 'test' });
      await store.close();
      store = new Driver(path);
      await store.init();
      made.ctx.store = store;
      expect((await store.getCampaign(campaign.id))?.audienceCondition).toEqual({ op: 'tag', tag: 'vip' });
      expect(await campaignLinkStats(made.ctx, campaign.id)).toEqual([{ url: 'https://example.com/', clicks: 1, uniqueClicks: 1 }]);
      expect(await selectAudience(made.ctx, (await store.getCampaign(campaign.id))!)).toEqual([]);
    } finally { await store.close(); rmSync(folder, { recursive: true, force: true }); }
  });
}

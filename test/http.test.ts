import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/http/app.js';
import { createCampaign } from '../src/services/campaigns.js';
import type { ServiceContext } from '../src/services/context.js';
import { makeContext, tokenFromEmail, type FakeAdapter } from './helpers.js';

let server: Server;
let base: string;
let ctx: ServiceContext;
let adapter: FakeAdapter;

beforeAll(async () => {
  const made = await makeContext();
  ctx = made.ctx;
  adapter = made.adapter;
  server = createApp(ctx).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const json = (path: string, options: RequestInit = {}) =>
  fetch(base + path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
  });

const asAdmin = (path: string, options: RequestInit = {}) =>
  json(path, {
    ...options,
    headers: { authorization: 'Bearer test-admin-token', ...(options.headers ?? {}) },
  });

describe('公開端點', () => {
  it('健康檢查會回報目前的 store 與寄信管道', async () => {
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, provider: 'fake', store: 'memory' });
  });

  it('訂閱表單可以從別的網域打（CORS）', async () => {
    const response = await json('/api/public/subscribe', {
      method: 'POST',
      headers: { origin: 'https://my-site.test' },
      body: JSON.stringify({ email: 'form@example.com', source: 'website' }),
    });

    expect(response.status).toBe(201);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://my-site.test');
    expect(await response.json()).toMatchObject({ ok: true, status: 'pending' });
  });

  it('Email 無效回 400', async () => {
    const response = await json('/api/public/subscribe', {
      method: 'POST',
      body: JSON.stringify({ email: 'bad' }),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('Email');
  });

  it('確認連結會完成訂閱', async () => {
    const before = adapter.sent.length;
    await json('/api/public/subscribe', {
      method: 'POST',
      body: JSON.stringify({ email: 'confirm-me@example.com' }),
    });
    const token = tokenFromEmail(adapter.sent[before]!.html, 'confirm');

    const response = await fetch(`${base}/confirm?token=${encodeURIComponent(token)}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('訂閱完成');
    expect((await ctx.store.getSubscriberByEmail('confirm-me@example.com'))?.status).toBe(
      'subscribed',
    );
  });

  it('退訂用 GET 只顯示確認頁，POST 才真的退訂', async () => {
    const before = adapter.sent.length;
    await json('/api/public/subscribe', {
      method: 'POST',
      body: JSON.stringify({ email: 'bye@example.com' }),
    });
    const confirmToken = tokenFromEmail(adapter.sent[before]!.html, 'confirm');
    await fetch(`${base}/confirm?token=${encodeURIComponent(confirmToken)}`);

    const unsubToken = tokenFromEmail(
      `<a href="/unsubscribe?token=${encodeURIComponent(
        (await import('../src/core/tokens.js')).createToken(
          ctx.config.appSecret,
          'unsubscribe',
          'bye@example.com',
        ),
      )}">x</a>`,
      'unsubscribe',
    );

    const page = await fetch(`${base}/unsubscribe?token=${encodeURIComponent(unsubToken)}`);
    expect(await page.text()).toContain('確定取消訂閱');
    expect((await ctx.store.getSubscriberByEmail('bye@example.com'))?.status).toBe('subscribed');

    const done = await fetch(`${base}/unsubscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: unsubToken }),
    });
    expect(done.status).toBe(200);
    expect((await ctx.store.getSubscriberByEmail('bye@example.com'))?.status).toBe('unsubscribed');
  });

  it('封存 API 只列出已寄出的電子報', async () => {
    const campaign = await createCampaign(ctx, {
      title: '封存測試',
      slug: 'archive-test',
      bodyMarkdown: '內容',
    });

    let response = await fetch(`${base}/api/public/campaigns`);
    expect((await response.json()).items).toHaveLength(0);

    await ctx.store.updateCampaign(campaign.id, { status: 'sent', sentAt: new Date().toISOString() });
    response = await fetch(`${base}/api/public/campaigns`);
    expect((await response.json()).items[0]).toMatchObject({ slug: 'archive-test' });

    response = await fetch(`${base}/api/public/campaigns/archive-test`);
    expect((await response.json()).html).toContain('內容');
  });

  it('公開封存頁只顯示已寄出的電子報', async () => {
    const draft = await createCampaign(ctx, {
      title: '還在寫的草稿',
      slug: 'archive-html-draft',
      bodyMarkdown: '草稿不該出現',
    });
    const sent = await createCampaign(ctx, {
      title: '給讀者看的那期',
      slug: 'archive-html-sent',
      bodyMarkdown: '封存頁看得到這段',
    });
    await ctx.store.updateCampaign(sent.id, { status: 'sent', sentAt: new Date().toISOString() });

    const index = await fetch(`${base}/archive`);
    expect(index.status).toBe(200);
    const indexHtml = await index.text();
    expect(indexHtml).toContain('給讀者看的那期');
    expect(indexHtml).not.toContain('還在寫的草稿');

    const item = await fetch(`${base}/archive/archive-html-sent`);
    expect(item.status).toBe(200);
    expect(await item.text()).toContain('封存頁看得到這段');

    const hidden = await fetch(`${base}/archive/archive-html-draft`);
    expect(hidden.status).toBe(404);
    expect(draft.status).toBe('draft');
  });
});

describe('後台授權', () => {
  it('沒帶 token 打 API 回 401', async () => {
    const response = await json('/api/admin/subscribers');
    expect(response.status).toBe(401);
  });

  it('token 錯誤也回 401', async () => {
    const response = await json('/api/admin/subscribers', {
      headers: { authorization: 'Bearer wrong' },
    });
    expect(response.status).toBe(401);
  });

  it('帶對 token 就能讀名單', async () => {
    const response = await asAdmin('/api/admin/subscribers');
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty('items');
  });

  it('後台頁面未登入會導去登入頁', async () => {
    const response = await fetch(`${base}/admin`, { redirect: 'manual' });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('/admin/login');
  });

  it('登入成功會種 cookie', async () => {
    const response = await fetch(`${base}/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: 'test-admin-token', next: '/admin' }),
      redirect: 'manual',
    });
    expect(response.status).toBe(302);
    expect(response.headers.get('set-cookie')).toContain('nk_admin=');
  });
});

describe('後台 API', () => {
  it('可以建立電子報並預覽未存檔的內容', async () => {
    const created = await asAdmin('/api/admin/campaigns', {
      method: 'POST',
      body: JSON.stringify({ title: 'API 測試' }),
    });
    expect(created.status).toBe(201);
    const campaign = await created.json();

    const preview = await asAdmin(`/api/admin/campaigns/${campaign.id}/preview`, {
      method: 'POST',
      body: JSON.stringify({ bodyMarkdown: '**尚未存檔**' }),
    });
    const data = await preview.json();
    expect(data.html).toContain('<strong>尚未存檔</strong>');

    const saved = await asAdmin(`/api/admin/campaigns/${campaign.id}`);
    expect((await saved.json()).bodyMarkdown).not.toContain('尚未存檔');
  });

  it('檢查寄信設定會回報目前 adapter', async () => {
    const response = await asAdmin('/api/admin/email/verify');
    expect(await response.json()).toMatchObject({ ok: true, provider: 'fake' });
  });

  it('匯出 CSV 回 text/csv', async () => {
    const response = await asAdmin('/api/admin/subscribers/export.csv');
    expect(response.headers.get('content-type')).toContain('text/csv');
    expect(await response.text()).toContain('email,name,status');
  });

  it('未知的 API 路徑回 404 JSON', async () => {
    const response = await asAdmin('/api/admin/nope');
    expect(response.status).toBe(404);
    expect(await response.json()).toHaveProperty('error');
  });
});

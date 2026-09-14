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

  it('簽名圖示是公開的 PNG', async () => {
    const response = await fetch(`${base}/sig-icons/instagram.png`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/image\/png/);
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect((await fetch(`${base}/sig-icons/nope.png`)).status).toBe(404);
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

  it('總覽會回開信率與點擊率', async () => {
    const response = await asAdmin('/api/admin/overview');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      rates: { sent: 0, uniqueOpens: 0, uniqueClicks: 0, openRate: null, clickRate: null },
    });
  });

  it('可以建立電子報資料夾並批次加入', async () => {
    const created = await asAdmin('/api/admin/campaign-folders', {
      method: 'POST',
      body: JSON.stringify({ name: '九月檔' }),
    });
    expect(created.status).toBe(201);
    const folder = await created.json();

    const campaign = await (
      await asAdmin('/api/admin/campaigns', {
        method: 'POST',
        body: JSON.stringify({ title: '要歸檔' }),
      })
    ).json();

    const moved = await asAdmin('/api/admin/campaigns/bulk', {
      method: 'POST',
      body: JSON.stringify({ ids: [campaign.id], action: 'folder', folderId: folder.id }),
    });
    expect(moved.status).toBe(200);

    const listed = await asAdmin(`/api/admin/campaigns?folderId=${folder.id}`);
    const data = await listed.json();
    expect(data.total).toBe(1);
    expect(data.items[0].title).toBe('要歸檔');
  });

  it('檢查寄信設定會回報目前 adapter', async () => {
    const response = await asAdmin('/api/admin/email/verify');
    expect(await response.json()).toMatchObject({ ok: true, provider: 'fake' });
  });

  it('可以建立資料夾並篩選名單', async () => {
    const created = await asAdmin('/api/admin/folders', {
      method: 'POST',
      body: JSON.stringify({ name: '設計' }),
    });
    expect(created.status).toBe(201);
    const folder = await created.json();

    await asAdmin('/api/admin/subscribers', {
      method: 'POST',
      body: JSON.stringify({ email: 'folder@example.com', folderId: folder.id, tags: 'vip' }),
    });

    const listed = await asAdmin(`/api/admin/subscribers?folderId=${folder.id}`);
    const data = await listed.json();
    expect(data.total).toBe(1);
    expect(data.items[0].email).toBe('folder@example.com');
    expect(data.items[0].tags).toContain('vip');
  });

  it('匯出 CSV 回 text/csv', async () => {
    const response = await asAdmin('/api/admin/subscribers/export.csv');
    expect(response.headers.get('content-type')).toContain('text/csv');
    expect(await response.text()).toContain('email,name,status');
  });

  it('可以用 Excel 檔匯入名單', async () => {
    const XLSX = await import('xlsx');
    const sheet = XLSX.utils.aoa_to_sheet([
      ['email', 'name'],
      ['file-import@example.com', '檔案匯入'],
    ]);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, '名單');
    const buffer = Buffer.from(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));

    const response = await asAdmin('/api/admin/subscribers/import', {
      method: 'POST',
      body: JSON.stringify({
        fileName: 'list.xlsx',
        fileBase64: buffer.toString('base64'),
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ created: 1 });
    expect((await ctx.store.getSubscriberByEmail('file-import@example.com'))?.name).toBe('檔案匯入');
  });

  it('訂閱落地頁可以打開', async () => {
    const response = await fetch(`${base}/join`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('訂閱');
  });

  it('簽名匯入 webhook 會寫入名單', async () => {
    const body = JSON.stringify({ email: 'ingest@example.com', tags: ['design'], source: 'portaly' });
    const { hmacSha256Hex } = await import('../src/core/tokens.js');
    const response = await json('/api/public/ingest', {
      method: 'POST',
      headers: { 'x-newsletter-signature': `sha256=${hmacSha256Hex('ingest-secret', body)}` },
      body,
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ ok: true, action: 'created' });
  });

  it('匯入簽章錯回 401', async () => {
    const response = await json('/api/public/ingest', {
      method: 'POST',
      headers: { 'x-newsletter-signature': 'sha256=deadbeef' },
      body: JSON.stringify({ email: 'x@example.com' }),
    });
    expect(response.status).toBe(401);
  });

  it('電子報列表支援搜尋', async () => {
    await asAdmin('/api/admin/campaigns', {
      method: 'POST',
      body: JSON.stringify({ title: '可被搜到的週報' }),
    });
    const response = await asAdmin('/api/admin/campaigns?search=週報');
    const data = await response.json();
    expect(data.items.some((c: { title: string }) => c.title.includes('週報'))).toBe(true);
  });

  it('可以建立並插入內容範本', async () => {
    const created = await asAdmin('/api/admin/templates', {
      method: 'POST',
      body: JSON.stringify({ name: 'Email/Welcome', html: '<p>歡迎</p>' }),
    });
    expect(created.status).toBe(201);
    const listed = await asAdmin('/api/admin/templates');
    expect((await listed.json()).items[0].name).toBe('Email/Welcome');
  });

  it('後台上傳圖片後可用公開網址讀到', async () => {
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const denied = await json('/api/admin/uploads', {
      method: 'POST',
      body: JSON.stringify({ fileBase64: png }),
    });
    expect(denied.status).toBe(401);

    const created = await asAdmin('/api/admin/uploads', {
      method: 'POST',
      body: JSON.stringify({ fileName: 'dot.png', fileBase64: png }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { url: string; mime: string };
    expect(body.mime).toBe('image/png');
    expect(body.url).toMatch(/^\/media\/img_/);

    const file = await fetch(base + body.url);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toMatch(/image\/png/);

    const bad = await asAdmin('/api/admin/uploads', {
      method: 'POST',
      body: JSON.stringify({ fileBase64: 'PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjwvc3ZnPg==' }),
    });
    expect(bad.status).toBe(400);
  });

  it('未知的 API 路徑回 404 JSON', async () => {
    const response = await asAdmin('/api/admin/nope');
    expect(response.status).toBe(404);
    expect(await response.json()).toHaveProperty('error');
  });
});

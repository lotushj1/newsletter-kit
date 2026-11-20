import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/http/app.js';
import type { ServiceContext } from '../src/services/context.js';
import { joinDisclosure } from '../src/services/consent.js';
import { makeContext, testConfig } from './helpers.js';

let server: Server;
let base: string;
let ctx: ServiceContext;

beforeAll(async () => {
  const made = await makeContext({
    join: { headline: undefined, description: '每週分享設計與工具。', tags: [], frequency: '每週一封', contactEmail: 'hello@example.com' },
  });
  ctx = made.ctx;
  server = createApp(ctx).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe('公開首頁與訂閱頁', () => {
  it('首頁交代發行者、內容、頻率，並導到訂閱頁', async () => {
    const response = await fetch(`${base}/`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('每週分享設計與工具。');
    expect(html).toContain('寄送頻率：每週一封');
    expect(html).toContain('href="/join"');
    expect(html).toContain('退訂連結');
  });

  it('訂閱頁說明用途、確認信、追蹤、退訂與聯絡方式，表單欄位都有 label', async () => {
    const html = await (await fetch(`${base}/join`)).text();
    expect(html).toContain('不會拿去做別的用途');
    expect(html).toContain('確認信');
    expect(html).toContain('開信');
    expect(html).toContain('退訂連結');
    expect(html).toContain('hello@example.com');
    expect(html).toContain('<label for="join-email">');
    expect(html).toContain('<label for="join-name">');
  });

  it('送出錯誤時保留填過的內容，錯誤訊息會被讀屏工具唸出', async () => {
    const response = await fetch(`${base}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'email=not-an-email&name=%E9%98%BF%E6%98%8E',
    });
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-describedby="join-notice"');
    expect(html).toContain('value="not-an-email"');
    expect(html).toContain('value="阿明"');
  });

  it('送出成功用 status 告知下一步', async () => {
    const response = await fetch(`${base}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'email=new%40example.com',
    });
    const html = await response.text();
    expect(html).toContain('role="status"');
    expect(html).toContain('確認信已寄出');
  });
});

describe('訂閱說明文字', () => {
  it('關掉開信追蹤就不寫追蹤說明；單次同意就不寫確認信', () => {
    const lines = joinDisclosure({ publisher: 'X', trackingEnabled: false, doubleOptIn: false });
    expect(lines.join('')).not.toContain('開信');
    expect(lines.join('')).not.toContain('確認信');
    expect(testConfig().trackingEnabled).toBe(true);
  });
});

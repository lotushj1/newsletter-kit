import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  flushNotionSync,
  notionStatusFor,
  upsertNotionSubscriber,
} from '../src/services/notion-sync.js';
import { ingestSubscriber } from '../src/services/ingest.js';
import { createSubscriber, unsubscribeByEmail } from '../src/services/subscribers.js';
import { makeContext } from './helpers.js';

type Call = { url: string; method: string; body: any };

function fakeNotion(existing: boolean, fail = false) {
  const calls: Call[] = [];
  const impl = vi.fn(async (url: any, init: any) => {
    calls.push({ url: String(url), method: init.method, body: JSON.parse(init.body) });
    if (fail) return new Response('nope', { status: 500 });
    if (String(url).endsWith('/query')) {
      return Response.json({ results: existing ? [{ id: 'page-1' }] : [] });
    }
    return Response.json({ id: 'page-1' });
  });
  return { calls, impl };
}

describe('Notion 同步', () => {
  beforeEach(() => {
    process.env.NOTION_TOKEN = 'test-token';
    process.env.NOTION_SUBSCRIBERS_DB_ID = 'db-1';
  });
  afterEach(() => {
    delete process.env.NOTION_TOKEN;
    delete process.env.NOTION_SUBSCRIBERS_DB_ID;
    vi.unstubAllGlobals();
  });

  it('狀態對應：只有 subscribed 是訂閱中', () => {
    expect(notionStatusFor('subscribed')).toBe('訂閱中');
    expect(notionStatusFor('pending')).toBe('已退訂');
    expect(notionStatusFor('unsubscribed')).toBe('已退訂');
    expect(notionStatusFor('bounced')).toBe('已退訂');
  });

  it('找不到 email 就新建列', async () => {
    const { calls, impl } = fakeNotion(false);
    expect(await upsertNotionSubscriber('A@Example.com', 'subscribed', impl as any)).toBe('created');
    expect(calls[0]!.body.filter.title.equals).toBe('a@example.com');
    const props = calls[1]!.body.properties;
    expect(props.狀態.select.name).toBe('訂閱中');
    expect(props.來源.multi_select[0].name).toBe('newsletter-kit');
  });

  it('已存在就只更新狀態', async () => {
    const { calls, impl } = fakeNotion(true);
    expect(await upsertNotionSubscriber('a@example.com', 'unsubscribed', impl as any)).toBe('updated');
    expect(calls[1]!.method).toBe('PATCH');
    expect(calls[1]!.body.properties).toEqual({ 狀態: { select: { name: '已退訂' } } });
  });

  it('沒設環境變數就不做事', async () => {
    delete process.env.NOTION_TOKEN;
    const { impl } = fakeNotion(false);
    expect(await upsertNotionSubscriber('a@example.com', 'subscribed', impl as any)).toBe('skipped');
    expect(impl).not.toHaveBeenCalled();
  });

  it('訂閱、匯入、退訂都會觸發同步；Notion 壞掉也不影響流程', async () => {
    const { calls, impl } = fakeNotion(false, true);
    vi.stubGlobal('fetch', impl);
    const { ctx } = await makeContext();
    const created = await createSubscriber(ctx, { email: 'x@example.com' });
    expect(created.status).toBe('subscribed');
    await ingestSubscriber(ctx, { email: 'y@example.com' });
    const result = await unsubscribeByEmail(ctx, 'x@example.com');
    expect(result.ok).toBe(true);
    await flushNotionSync();
    const queried = calls.filter((c) => c.url.endsWith('/query')).map((c) => c.body.filter.title.equals);
    expect(queried).toEqual(['x@example.com', 'y@example.com', 'x@example.com']);
  });
});

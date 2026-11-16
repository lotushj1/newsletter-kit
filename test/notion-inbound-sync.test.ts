import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  maybeSyncFromNotion,
  notionSubscriberId,
  resetNotionInboundThrottle,
} from '../src/services/notion-inbound-sync.js';
import { createScheduler } from '../src/services/scheduler.js';
import { makeContext } from './helpers.js';

const NOW = Date.parse('2026-11-16T03:00:00.000Z');
const SINCE = new Date(NOW - 48 * 60 * 60 * 1000).toISOString();

function page(opts: {
  email: string;
  status?: '訂閱中' | '已退訂';
  created: string;
  edited?: string;
  subscribedAt?: string;
  sources?: string[];
  name?: string;
}) {
  return {
    object: 'page',
    created_time: opts.created,
    last_edited_time: opts.edited ?? opts.created,
    properties: {
      email: { type: 'title', title: [{ plain_text: opts.email }] },
      狀態: { type: 'select', select: { name: opts.status ?? '訂閱中' } },
      訂閱日: { type: 'date', date: opts.subscribedAt ? { start: opts.subscribedAt } : null },
      來源: { type: 'multi_select', multi_select: (opts.sources ?? ['創作邦官網 InsForge']).map((name) => ({ name })) },
      名稱: { type: 'rich_text', rich_text: opts.name ? [{ plain_text: opts.name }] : [] },
    },
  };
}

/** 假的 Notion API：依 page_size 分頁，記下每次查詢的 cursor。 */
function fakeNotion(pages: any[]) {
  const queries: any[] = [];
  const fetchImpl = (async (url: string, init: any) => {
    expect(url).toBe('https://api.notion.com/v1/databases/db_test/query');
    const body = JSON.parse(init.body);
    queries.push(body);
    const since = body.filter.last_edited_time.on_or_after;
    const matched = pages.filter((p) => p.last_edited_time >= since).sort((a, b) => a.last_edited_time.localeCompare(b.last_edited_time));
    const start = Number(body.start_cursor ?? 0);
    const slice = matched.slice(start, start + body.page_size);
    const more = start + body.page_size < matched.length;
    return new Response(JSON.stringify({ results: slice, has_more: more, next_cursor: more ? String(start + body.page_size) : null }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, queries };
}

const suppressionKey = (email: string) => `suppression:${createHash('sha256').update(email).digest('hex')}`;

describe('從 Notion 拉回官網新訂閱', () => {
  beforeEach(() => {
    vi.stubEnv('NOTION_TOKEN', 'secret_test');
    vi.stubEnv('NOTION_SUBSCRIBERS_DB_ID', 'db_test');
    resetNotionInboundThrottle();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('新訂閱者加入名單：訂閱中、帶來源標籤、不寄任何信', async () => {
    const { ctx, adapter, store } = await makeContext();
    const { fetchImpl } = fakeNotion([
      page({ email: 'New.Reader@Example.com', created: '2026-11-16T02:10:00.000Z', subscribedAt: '2026-11-16T02:09:00.000+00:00', name: '小明' }),
      page({ email: 'portaly@example.com', created: '2026-11-16T02:20:00.000Z', sources: ['Portaly'] }),
    ]);
    const summary = await maybeSyncFromNotion(ctx, { fetchImpl, now: NOW });
    expect(summary).toMatchObject({ ran: true, checked: 2, added: 2 });
    const a = await store.getSubscriberByEmail('new.reader@example.com');
    expect(a).toMatchObject({ status: 'subscribed', tags: ['創作邦官網'], name: '小明', createdAt: '2026-11-16T02:09:00.000Z' });
    expect(a?.id).toBe(notionSubscriberId('new.reader@example.com'));
    expect((await store.getSubscriberByEmail('portaly@example.com'))?.tags).toEqual(['portaly']);
    expect(adapter.sent).toHaveLength(0);
  });

  it('同步開始之前就存在、卻不在名單裡的人不加（例如刻意清除的舊會員）', async () => {
    const { ctx, store } = await makeContext();
    const { fetchImpl } = fakeNotion([
      page({ email: 'purged@example.com', created: '2026-08-01T00:00:00.000Z', edited: '2026-11-16T01:00:00.000Z' }),
    ]);
    const summary = await maybeSyncFromNotion(ctx, { fetchImpl, now: NOW });
    expect(summary).toMatchObject({ checked: 1, added: 0, skippedOld: 1 });
    expect(await store.getSubscriberByEmail('purged@example.com')).toBeNull();
  });

  it('Notion 已退訂 → 名單跟著退訂', async () => {
    const { ctx, store } = await makeContext();
    await store.createSubscriber({ id: 'sub_a', email: 'a@example.com', status: 'subscribed', tags: [], createdAt: '2026-01-01T00:00:00.000Z' });
    const { fetchImpl } = fakeNotion([
      page({ email: 'a@example.com', status: '已退訂', created: '2026-01-01T00:00:00.000Z', edited: '2026-11-16T02:00:00.000Z' }),
    ]);
    const summary = await maybeSyncFromNotion(ctx, { fetchImpl, now: NOW });
    expect(summary.unsubscribed).toBe(1);
    expect((await store.getSubscriber('sub_a'))?.status).toBe('unsubscribed');
  });

  it('名單裡已退訂的人：舊資料不會翻回訂閱中，訂閱日晚於退訂才恢復', async () => {
    const { ctx, store } = await makeContext();
    await store.createSubscriber({ id: 'sub_old', email: 'old@example.com', status: 'unsubscribed', tags: [], createdAt: '2026-01-01T00:00:00.000Z', unsubscribedAt: '2026-11-15T10:00:00.000Z' });
    await store.createSubscriber({ id: 'sub_back', email: 'back@example.com', status: 'unsubscribed', tags: [], createdAt: '2026-01-01T00:00:00.000Z', unsubscribedAt: '2026-11-15T10:00:00.000Z' });
    const { fetchImpl } = fakeNotion([
      page({ email: 'old@example.com', created: '2026-01-01T00:00:00.000Z', edited: '2026-11-16T01:00:00.000Z', subscribedAt: '2026-01-01T00:00:00.000Z' }),
      page({ email: 'back@example.com', created: '2026-01-01T00:00:00.000Z', edited: '2026-11-16T02:00:00.000Z', subscribedAt: '2026-11-16T01:59:00.000Z' }),
    ]);
    const summary = await maybeSyncFromNotion(ctx, { fetchImpl, now: NOW });
    expect(summary).toMatchObject({ skippedConflict: 1, resubscribed: 1 });
    expect((await store.getSubscriber('sub_old'))?.status).toBe('unsubscribed');
    expect((await store.getSubscriber('sub_back'))?.status).toBe('subscribed');
  });

  it('退信／檢舉名單裡的地址不會被加回來', async () => {
    const { ctx, store } = await makeContext();
    await store.setSetting(suppressionKey('bounced@example.com'), 'bounce');
    const { fetchImpl } = fakeNotion([page({ email: 'bounced@example.com', created: '2026-11-16T02:00:00.000Z' })]);
    const summary = await maybeSyncFromNotion(ctx, { fetchImpl, now: NOW });
    expect(summary).toMatchObject({ added: 0, skippedSuppressed: 1 });
    expect(await store.getSubscriberByEmail('bounced@example.com')).toBeNull();
  });

  it('重複執行不會重複加人；游標往前推、分頁會翻完', async () => {
    const { ctx, store } = await makeContext();
    const pages = Array.from({ length: 130 }, (_, i) =>
      page({ email: `r${i}@example.com`, created: new Date(NOW - 60 * 60 * 1000 + i * 1000).toISOString() }),
    );
    const { fetchImpl, queries } = fakeNotion(pages);
    expect((await maybeSyncFromNotion(ctx, { fetchImpl, now: NOW })).added).toBe(130);
    expect(queries[0].filter.last_edited_time.on_or_after).toBe(SINCE);
    expect(queries).toHaveLength(2);
    const state = JSON.parse((await store.getSetting('notion_inbound_sync'))!);
    expect(state.cursor).toBe(pages[129].last_edited_time);

    const second = await maybeSyncFromNotion(ctx, { fetchImpl, now: NOW + 10 * 60 * 1000 });
    expect(second.added).toBe(0);
    expect((await store.listAudience({})).length).toBe(130);
    expect(queries.at(-1).filter.last_edited_time.on_or_after).toBe(pages[129].last_edited_time);
  });

  it('5 分鐘內只查一次；沒設 Notion 或設 NOTION_INBOUND_SYNC=false 時不做事', async () => {
    const { ctx } = await makeContext();
    const { fetchImpl, queries } = fakeNotion([]);
    expect((await maybeSyncFromNotion(ctx, { fetchImpl, now: NOW })).ran).toBe(true);
    expect((await maybeSyncFromNotion(ctx, { fetchImpl, now: NOW + 60_000 })).reason).toBe('throttled');
    expect(queries).toHaveLength(1);

    vi.stubEnv('NOTION_INBOUND_SYNC', 'false');
    expect((await maybeSyncFromNotion(ctx, { fetchImpl, now: NOW + 10 * 60_000 })).reason).toBe('disabled');
    vi.stubEnv('NOTION_INBOUND_SYNC', '');
    vi.stubEnv('NOTION_TOKEN', '');
    expect((await maybeSyncFromNotion(ctx, { fetchImpl, now: NOW + 20 * 60_000 })).reason).toBe('notion_not_configured');
    expect(queries).toHaveLength(1);
  });

  it('沒有變動時不寫入資料（避免每 5 分鐘搬整份名單）', async () => {
    const { ctx, store } = await makeContext();
    const { fetchImpl } = fakeNotion([]);
    await maybeSyncFromNotion(ctx, { fetchImpl, now: NOW });
    const spy = vi.spyOn(store, 'setSetting');
    await maybeSyncFromNotion(ctx, { fetchImpl, now: NOW + 10 * 60_000 });
    expect(spy).not.toHaveBeenCalled();
  });

  it('排程關閉時排程器的 tick 仍會同步名單，但不寄信', async () => {
    const { ctx, adapter, store } = await makeContext({ scheduler: { enabled: false, pollMs: 1000, cronSecret: undefined } });
    const { fetchImpl } = fakeNotion([page({ email: 'tick@example.com', created: new Date(Date.now() - 60_000).toISOString() })]);
    vi.stubGlobal('fetch', fetchImpl);
    const summary = await createScheduler(ctx).tick();
    expect(summary.skippedReason).toBe('scheduler_disabled');
    expect(summary.notion?.added).toBe(1);
    expect((await store.getSubscriberByEmail('tick@example.com'))?.status).toBe('subscribed');
    expect(adapter.sent).toHaveLength(0);
  });
});

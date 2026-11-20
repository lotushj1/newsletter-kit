import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/http/app.js';
import {
  approveHeldUnsubscribes,
  getNotionInboundStatus,
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

  it('名單裡已退訂的人：Notion 上重新出現訂閱中也不自動加回，要本人重新訂閱並確認', async () => {
    const { ctx, store } = await makeContext();
    await store.createSubscriber({ id: 'sub_old', email: 'old@example.com', status: 'unsubscribed', tags: [], createdAt: '2026-01-01T00:00:00.000Z', unsubscribedAt: '2026-11-15T10:00:00.000Z' });
    await store.createSubscriber({ id: 'sub_back', email: 'back@example.com', status: 'unsubscribed', tags: [], createdAt: '2026-01-01T00:00:00.000Z', unsubscribedAt: '2026-11-15T10:00:00.000Z' });
    const { fetchImpl } = fakeNotion([
      page({ email: 'old@example.com', created: '2026-01-01T00:00:00.000Z', edited: '2026-11-16T01:00:00.000Z', subscribedAt: '2026-01-01T00:00:00.000Z' }),
      page({ email: 'back@example.com', created: '2026-01-01T00:00:00.000Z', edited: '2026-11-16T02:00:00.000Z', subscribedAt: '2026-11-16T01:59:00.000Z' }),
    ]);
    const summary = await maybeSyncFromNotion(ctx, { fetchImpl, now: NOW });
    expect(summary).toMatchObject({ skippedConflict: 1, resubscribed: 0, needsConfirmation: 1 });
    expect((await store.getSubscriber('sub_old'))?.status).toBe('unsubscribed');
    expect((await store.getSubscriber('sub_back'))?.status).toBe('unsubscribed');
  });

  it('還在等確認的人：Notion 上訂閱日比較新就算完成訂閱，並記下同意來源', async () => {
    const { ctx, store } = await makeContext();
    await store.createSubscriber({ id: 'sub_wait', email: 'wait@example.com', status: 'pending', tags: [], createdAt: '2026-11-15T10:00:00.000Z' });
    const { fetchImpl } = fakeNotion([
      page({ email: 'wait@example.com', created: '2026-11-15T10:00:00.000Z', edited: '2026-11-16T02:00:00.000Z', subscribedAt: '2026-11-16T01:59:00.000Z' }),
    ]);
    const summary = await maybeSyncFromNotion(ctx, { fetchImpl, now: NOW });
    expect(summary).toMatchObject({ resubscribed: 1 });
    const after = await store.getSubscriber('sub_wait');
    expect(after?.status).toBe('subscribed');
    expect(after?.confirmedAt).toBeUndefined();
    expect(after?.meta?.consent).toMatchObject({ method: 'notion', at: '2026-11-16T01:59:00.000Z' });
  });

  it('Notion 上退訂的人也會記進排除名單；之後被刪除再從 Notion 出現也不會加回', async () => {
    const { ctx, store } = await makeContext();
    await store.createSubscriber({ id: 'sub_leave', email: 'leave@example.com', status: 'subscribed', tags: [], createdAt: '2026-01-01T00:00:00.000Z' });
    const { fetchImpl } = fakeNotion([
      page({ email: 'leave@example.com', status: '已退訂', created: '2026-01-01T00:00:00.000Z', edited: '2026-11-16T02:00:00.000Z' }),
    ]);
    await maybeSyncFromNotion(ctx, { fetchImpl, now: NOW });
    expect((await store.getSubscriber('sub_leave'))?.status).toBe('unsubscribed');
    expect(await store.getSetting(suppressionKey('leave@example.com'))).toBe('unsubscribe');
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

describe('Notion 一次退訂太多人時先暫停', () => {
  beforeEach(() => {
    vi.stubEnv('NOTION_TOKEN', 'secret_test');
    vi.stubEnv('NOTION_SUBSCRIBERS_DB_ID', 'db_test');
    resetNotionInboundThrottle();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  async function withSubscribers(count: number) {
    const made = await makeContext();
    for (let i = 0; i < count; i += 1) {
      await made.store.createSubscriber({ id: `sub_${i}`, email: `m${i}@example.com`, status: 'subscribed', tags: [], createdAt: '2026-01-01T00:00:00.000Z' });
    }
    return made;
  }
  const bulkUnsubscribe = (count: number, edited = '2026-11-16T02:30:00.000Z') =>
    Array.from({ length: count }, (_, i) =>
      page({ email: `m${i}@example.com`, status: '已退訂', created: '2026-01-01T00:00:00.000Z', edited }),
    );
  const subscribedCount = async (store: any) => (await store.listAudience({})).length;

  it('超過上限（預設 20 人）整批不套用、游標不前進，重跑也不重複寫入', async () => {
    const { ctx, store } = await withSubscribers(25);
    const { fetchImpl, queries } = fakeNotion(bulkUnsubscribe(25));
    const summary = await maybeSyncFromNotion(ctx, { fetchImpl, now: NOW });
    expect(summary).toMatchObject({ ran: true, held: true, pendingUnsubscribes: 25, unsubscribed: 0, reason: 'too_many_unsubscribes' });
    expect(await subscribedCount(store)).toBe(25);
    const state = JSON.parse((await store.getSetting('notion_inbound_sync'))!);
    expect(state.cursor).toBe(SINCE);
    expect(state.held.unsubscribes).toBe(25);
    expect((await getNotionInboundStatus(ctx)).held?.unsubscribes).toBe(25);

    const spy = vi.spyOn(store, 'setSetting');
    const again = await maybeSyncFromNotion(ctx, { fetchImpl, now: NOW + 10 * 60_000 });
    expect(again.held).toBe(true);
    expect(spy).not.toHaveBeenCalled();
    expect(queries.at(-1).filter.last_edited_time.on_or_after).toBe(SINCE);
  });

  it('後台確認後才套用，套用完解除暫停', async () => {
    const { ctx, store } = await withSubscribers(25);
    const { fetchImpl } = fakeNotion(bulkUnsubscribe(25));
    await maybeSyncFromNotion(ctx, { fetchImpl, now: NOW });
    const applied = await approveHeldUnsubscribes(ctx, { fetchImpl, now: NOW + 60_000 });
    expect(applied).toMatchObject({ unsubscribed: 25 });
    expect(applied.held).toBeUndefined();
    expect(await subscribedCount(store)).toBe(0);
    const status = await getNotionInboundStatus(ctx);
    expect(status.held).toBeNull();
    expect(JSON.parse((await store.getSetting('notion_inbound_sync'))!).approvedUnsubscribes).toBeUndefined();
  });

  it('確認之後 Notion 又多了更多退訂：再暫停一次', async () => {
    const { ctx, store } = await withSubscribers(40);
    const notionPages = bulkUnsubscribe(25);
    const { fetchImpl } = fakeNotion(notionPages);
    await maybeSyncFromNotion(ctx, { fetchImpl, now: NOW });
    notionPages.push(...bulkUnsubscribe(40).slice(25));
    const result = await approveHeldUnsubscribes(ctx, { fetchImpl, now: NOW + 60_000 });
    expect(result).toMatchObject({ held: true, pendingUnsubscribes: 40, unsubscribed: 0 });
    expect(await subscribedCount(store)).toBe(40);
  });

  it('在 Notion 改回訂閱中：自動解除暫停，名單完全沒被動到', async () => {
    const { ctx, store } = await withSubscribers(25);
    const notionPages = bulkUnsubscribe(25);
    const { fetchImpl } = fakeNotion(notionPages);
    await maybeSyncFromNotion(ctx, { fetchImpl, now: NOW });
    for (const p of notionPages) {
      p.properties['狀態'].select.name = '訂閱中';
      p.last_edited_time = '2026-11-16T02:40:00.000Z';
    }
    const summary = await maybeSyncFromNotion(ctx, { fetchImpl, now: NOW + 10 * 60_000 });
    expect(summary.held).toBeUndefined();
    expect(summary.unsubscribed).toBe(0);
    expect(await subscribedCount(store)).toBe(25);
    expect((await getNotionInboundStatus(ctx)).held).toBeNull();
  });

  it('上限以內照常套用；NOTION_INBOUND_MAX_UNSUBSCRIBES 可調整', async () => {
    const small = await withSubscribers(20);
    expect((await maybeSyncFromNotion(small.ctx, { fetchImpl: fakeNotion(bulkUnsubscribe(20)).fetchImpl, now: NOW })).unsubscribed).toBe(20);

    resetNotionInboundThrottle();
    vi.stubEnv('NOTION_INBOUND_MAX_UNSUBSCRIBES', '30');
    const big = await withSubscribers(25);
    expect((await maybeSyncFromNotion(big.ctx, { fetchImpl: fakeNotion(bulkUnsubscribe(25)).fetchImpl, now: NOW })).unsubscribed).toBe(25);
  });

  it('同一分鐘批次修改超過一輪的量：分頁接著讀，後面的新訂閱不會卡住', async () => {
    const { ctx, store } = await makeContext();
    const sameMinute = '2026-11-16T02:00:00.000Z';
    const flood = Array.from({ length: 1200 }, (_, i) =>
      page({ email: `old${i}@example.com`, created: '2026-08-01T00:00:00.000Z', edited: sameMinute }),
    );
    const fresh = page({ email: 'fresh@example.com', created: '2026-11-16T02:01:00.000Z' });
    const { fetchImpl } = fakeNotion([...flood, fresh]);

    const first = await maybeSyncFromNotion(ctx, { fetchImpl, now: NOW });
    expect(first.checked).toBe(500);
    let state = JSON.parse((await store.getSetting('notion_inbound_sync'))!);
    expect(state.cursor).toBe(SINCE);
    expect(state.pageCursor).toBe('500');

    await maybeSyncFromNotion(ctx, { fetchImpl, now: NOW + 10 * 60_000 });
    const third = await maybeSyncFromNotion(ctx, { fetchImpl, now: NOW + 20 * 60_000 });
    expect(third).toMatchObject({ checked: 201, added: 1 });
    state = JSON.parse((await store.getSetting('notion_inbound_sync'))!);
    expect(state.cursor).toBe('2026-11-16T02:01:00.000Z');
    expect(state.pageCursor).toBeUndefined();
    expect((await store.getSubscriberByEmail('fresh@example.com'))?.status).toBe('subscribed');
  });

  it('後台 API：總覽帶出暫停狀態，按確認後套用', async () => {
    const { ctx, store } = await withSubscribers(25);
    const { fetchImpl: notionFetch } = fakeNotion(bulkUnsubscribe(25));
    await maybeSyncFromNotion(ctx, { fetchImpl: notionFetch, now: NOW });

    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', ((url: any, init: any) =>
      String(url).startsWith('https://api.notion.com/') ? notionFetch(url, init) : realFetch(url, init)) as typeof fetch);
    const server = createApp(ctx).listen(0);
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/admin`;
      const headers = { authorization: 'Bearer test-admin-token', 'content-type': 'application/json' };
      const overview = await (await realFetch(`${base}/overview`, { headers })).json();
      expect(overview.notionSync.held.unsubscribes).toBe(25);

      const approve = await realFetch(`${base}/notion-sync/approve-unsubscribes`, { method: 'POST', headers });
      expect(approve.status).toBe(200);
      const body = await approve.json();
      expect(body.summary.unsubscribed).toBe(25);
      expect(body.status.held).toBeNull();
      expect(await subscribedCount(store)).toBe(0);

      const nothing = await realFetch(`${base}/notion-sync/approve-unsubscribes`, { method: 'POST', headers });
      expect(nothing.status).toBe(400);

      vi.stubEnv('NOTION_INBOUND_SYNC', 'false');
      const disabled = await realFetch(`${base}/notion-sync/approve-unsubscribes`, { method: 'POST', headers });
      expect(disabled.status).toBe(400);
      expect((await disabled.json()).error).toContain('沒有啟用');
    } finally {
      server.close();
    }
  });
});

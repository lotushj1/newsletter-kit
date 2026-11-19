import { describe, expect, it, vi } from 'vitest';
import { splitForUpload, type InsForgeBackend } from '../src/core/insforge.js';
import { createTrackingToken } from '../src/core/tokens.js';
import { recordClick, recordOpen } from '../src/services/tracking.js';
import { InsForgeStore } from '../src/store/insforge-store.js';
import type { MemorySnapshot } from '../src/store/memory-store.js';
import type { TrackingEvent } from '../src/store/types.js';
import { makeContext } from './helpers.js';

function emptySnapshot(): MemorySnapshot {
  return {
    subscribers: [],
    campaigns: [],
    deliveries: [],
    events: [],
    sequences: [],
    sequenceSteps: [],
    enrollments: [],
    folders: [],
    templates: [],
    settings: {},
    campaignStarters: [],
  };
}

/** 有收件匣的假後端；saveSnapshot 會讓出事件迴圈，才看得出並行寫入有沒有合併。 */
function inboxBackend(options: { inbox?: boolean } = {}) {
  let current: MemorySnapshot = emptySnapshot();
  const inbox = new Map<string, TrackingEvent>();
  const saves: MemorySnapshot[] = [];
  const backend: InsForgeBackend = {
    async loadSnapshot() {
      return structuredClone(current);
    },
    async saveSnapshot(snapshot) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      current = structuredClone(snapshot);
      saves.push(structuredClone(snapshot));
    },
    async snapshotExists() {
      return true;
    },
    async appendEvent(event) {
      if (options.inbox === false) return false;
      inbox.set(event.id, structuredClone(event));
      return true;
    },
    async listInboxEvents(limit) {
      return [...inbox.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, limit);
    },
    async deleteInboxEvents(ids) {
      for (const id of ids) inbox.delete(id);
    },
    async uploadImage(fileName) {
      return { url: fileName };
    },
    async sendEmail() {
      return {};
    },
  };
  return { backend, inbox, saves, current: () => current };
}

const event = (id: string, at = '2026-11-19T00:00:00.000Z'): TrackingEvent => ({
  id,
  campaignId: 'cmp_1',
  subscriberId: 'sub_1',
  deliveryId: 'dlv_1',
  type: 'open',
  createdAt: at,
});

describe('splitForUpload', () => {
  it('切段後能原樣接回，而且不會把 emoji 的代理對切開', () => {
    const text = `${'a'.repeat(9)}😀${'中'.repeat(7)}🎉z`;
    for (const size of [2, 3, 5, 10, 64]) {
      const parts = splitForUpload(text, size);
      expect(parts.join('')).toBe(text);
      for (const part of parts) {
        expect(part.length).toBeLessThanOrEqual(size);
        expect(/[\ud800-\udbff]$/.test(part)).toBe(false);
        expect(/^[\udc00-\udfff]/.test(part)).toBe(false);
      }
    }
    expect(splitForUpload('')).toEqual(['']);
  });
});

describe('追蹤事件收件匣', () => {
  it('開信事件只寫進收件匣，不重寫整份快照；排程併回後才進主資料', async () => {
    const { backend, inbox, saves, current } = inboxBackend();
    const store = new InsForgeStore(backend);
    await store.init();

    await store.createEvent(event('evt_1'));
    await store.createEvent(event('evt_2', '2026-11-19T00:00:01.000Z'));
    expect(saves).toHaveLength(0);
    expect(inbox.size).toBe(2);

    expect(await store.foldEventInbox()).toBe(2);
    expect(inbox.size).toBe(0);
    expect(saves).toHaveLength(1);
    expect(current().events.map((e) => e.id).sort()).toEqual(['evt_1', 'evt_2']);
    expect(await store.listTrackingEvents({ campaignId: 'cmp_1' })).toHaveLength(2);

    // 收件匣空了就不寫
    expect(await store.foldEventInbox()).toBe(0);
    expect(saves).toHaveLength(1);
  });

  it('同一筆事件併回兩次只算一次（上次刪收件匣失敗的情況）', async () => {
    const { backend, inbox, current } = inboxBackend();
    const store = new InsForgeStore(backend);
    await store.init();
    await store.createEvent(event('evt_1'));
    const kept = structuredClone(inbox.get('evt_1')!);
    await store.foldEventInbox();
    inbox.set('evt_1', kept);
    await store.foldEventInbox();
    expect(current().events.filter((e) => e.id === 'evt_1')).toHaveLength(1);
  });

  it('資料庫沒有收件匣時，退回直接寫快照', async () => {
    const { backend, saves, current } = inboxBackend({ inbox: false });
    const store = new InsForgeStore(backend);
    await store.init();
    await store.createEvent(event('evt_1'));
    expect(saves).toHaveLength(1);
    expect(current().events.map((e) => e.id)).toEqual(['evt_1']);
  });
});

describe('整份寫入合併', () => {
  it('排隊中的多次修改搭同一班寫入，全部都有寫進去', async () => {
    const { backend, saves, current } = inboxBackend();
    const store = new InsForgeStore(backend);
    await store.init();
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.setSetting(`k${i}`, String(i))));
    for (let i = 0; i < 20; i += 1) expect(current().settings[`k${i}`]).toBe(String(i));
    // 第一筆先寫，其餘 19 筆合併成下一班
    expect(saves.length).toBeLessThanOrEqual(2);
  });

  it('寫入開始後的修改會排下一班，不會漏掉', async () => {
    const { backend, current } = inboxBackend();
    const store = new InsForgeStore(backend);
    await store.init();
    const first = store.setSetting('a', '1');
    await new Promise((resolve) => setTimeout(resolve, 1));
    const second = store.setSetting('b', '2');
    await Promise.all([first, second]);
    expect(current().settings).toMatchObject({ a: '1', b: '2' });
  });
});

describe('追蹤寫入失敗時照樣回應讀者', () => {
  it('點擊記錄寫不進去也會回傳目的網址；開信照樣回傳成功', async () => {
    const { ctx } = await makeContext();
    vi.spyOn(ctx.store, 'createEvent').mockRejectedValue(new Error('資料層暫時無法寫入'));
    const base = { email: 'ada@example.com', campaignId: 'cmp_1', deliveryId: 'dlv_1', subscriberId: 'sub_1' };
    const click = createTrackingToken(ctx.config.appSecret, { ...base, purpose: 'click', url: 'https://example.com/articles/hello' });
    const open = createTrackingToken(ctx.config.appSecret, { ...base, purpose: 'open' });
    expect(await recordClick(ctx, click)).toBe('https://example.com/articles/hello');
    expect(await recordOpen(ctx, open)).toBe(true);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InsForgeBackend } from '../src/core/insforge.js';
import { InsForgeStore } from '../src/store/insforge-store.js';
import type { MemorySnapshot } from '../src/store/memory-store.js';
import type { TrackingEvent } from '../src/store/types.js';

type Versioned = MemorySnapshot & { __nk_version?: number };

function snapshot(version: number): Versioned {
  return {
    subscribers: [{ id: 'sub_1', email: 'ada@example.com', status: 'subscribed', tags: [], createdAt: '2026-11-01T00:00:00.000Z' }],
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
    __nk_version: version,
  };
}

/** 讀取結果可以排程：null 代表讀到空值（模擬資料庫介面重啟的空檔）。 */
function scriptedBackend(initial: Versioned) {
  let current: Versioned = structuredClone(initial);
  const reads: (Versioned | null | 'current')[] = [];
  const inbox: TrackingEvent[] = [];
  const backend: InsForgeBackend = {
    async loadSnapshot() {
      const next = reads.length > 0 ? reads.shift()! : 'current';
      return next === 'current' ? structuredClone(current) : next;
    },
    async saveSnapshot(s) {
      current = structuredClone(s as Versioned);
    },
    async snapshotExists() {
      return true;
    },
    async appendEvent(event) {
      inbox.push(event);
      return true;
    },
    async uploadImage(fileName) {
      return { url: fileName };
    },
    async sendEmail() {
      return {};
    },
  };
  return { backend, reads, inbox, current: () => current, setCurrent: (s: Versioned) => (current = structuredClone(s)) };
}

const event: TrackingEvent = {
  id: 'evt_1',
  campaignId: 'cmp_1',
  subscriberId: 'sub_1',
  deliveryId: 'dlv_1',
  type: 'open',
  createdAt: '2026-11-19T00:00:00.000Z',
};

/** 讓下一次讀取一定會跟遠端同步（快照讀取有 3 秒快取）。 */
function passReadTtl(): void {
  vi.setSystemTime(Date.now() + 4000);
}

describe('讀到空值與停寫的恢復', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('偶爾讀到一次空值，重讀成功就不會停寫', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { backend, reads } = scriptedBackend(snapshot(10));
    const store = new InsForgeStore(backend, { nullReadRetryDelaysMs: [1, 1] });
    await store.init();
    reads.push(null);
    passReadTtl();
    await store.listSubscribers({});
    expect(store.integrityStatus().ok).toBe(true);
    await store.setSetting('k', 'v');
  });

  it('一直讀到空值會停寫；之後讀回正常就自動恢復寫入', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { backend, reads, current } = scriptedBackend(snapshot(10));
    const store = new InsForgeStore(backend, { nullReadRetryDelaysMs: [1, 1] });
    await store.init();

    reads.push(null, null, null);
    passReadTtl();
    await store.listSubscribers({});
    expect(store.integrityStatus().ok).toBe(false);
    await expect(store.setSetting('k', 'v')).rejects.toThrow('讀到空值');

    passReadTtl();
    await store.listSubscribers({});
    expect(store.integrityStatus().ok).toBe(true);
    await store.setSetting('k', 'v');
    expect(current().settings.k).toBe('v');
  });

  it('停寫期間開信、點擊照樣寫進收件匣', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { backend, reads, inbox } = scriptedBackend(snapshot(10));
    const store = new InsForgeStore(backend, { nullReadRetryDelaysMs: [1, 1] });
    await store.init();
    reads.push(null, null, null);
    passReadTtl();
    await store.listSubscribers({});
    expect(store.integrityStatus().ok).toBe(false);

    await store.createEvent(event);
    expect(inbox.map((e) => e.id)).toEqual(['evt_1']);
  });

  it('版本倒退這類真正的損毀不會自動恢復', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { backend, setCurrent } = scriptedBackend(snapshot(10));
    const store = new InsForgeStore(backend, { nullReadRetryDelaysMs: [1, 1] });
    await store.init();
    setCurrent(snapshot(3));
    passReadTtl();
    await store.listSubscribers({});
    expect(store.integrityStatus().ok).toBe(false);

    passReadTtl();
    await store.listSubscribers({});
    expect(store.integrityStatus().ok).toBe(false);
    await expect(store.setSetting('k', 'v')).rejects.toThrow('版本倒退');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { createInsForgeAdapter } from '../src/email/adapters/insforge.js';
import type { InsForgeBackend } from '../src/core/insforge.js';
import { InsForgeStore } from '../src/store/insforge-store.js';
import type { MemorySnapshot } from '../src/store/memory-store.js';
import { mergeSnapshots } from '../src/store/snapshot-merge.js';
import type { Campaign, CampaignStarter } from '../src/store/types.js';
import { EMPTY_TRACKING } from '../src/store/types.js';

function sortedJsonKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(sortedJsonKeys) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, sortedJsonKeys(nested)]),
    ) as T;
  }
  return value;
}

function fakeBackend(
  initial: MemorySnapshot | null = null,
  { reorderKeys = false }: { reorderKeys?: boolean } = {},
): InsForgeBackend & { saved: MemorySnapshot[] } {
  let current = initial ? structuredClone(initial) : null;
  const saved: MemorySnapshot[] = [];
  return {
    saved,
    async loadSnapshot() {
      return current ? (reorderKeys ? sortedJsonKeys(current) : structuredClone(current)) : null;
    },
    async saveSnapshot(snapshot) {
      current = structuredClone(snapshot);
      saved.push(structuredClone(snapshot));
    },
    async uploadImage(fileName) {
      return { url: `https://files.example/${fileName}` };
    },
    async sendEmail() {
      return { id: 'msg_1' };
    },
  };
}

describe('InsForgeStore', () => {
  it('啟動時讀回 snapshot，寫入會存回去', async () => {
    const backend = fakeBackend({
      subscribers: [
        {
          id: 'sub_1',
          email: 'ada@example.com',
          status: 'subscribed',
          tags: [],
          createdAt: '2026-09-14T00:00:00.000Z',
        },
      ],
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
    });
    const store = new InsForgeStore(backend);
    await store.init();
    expect(await store.getSubscriberByEmail('ada@example.com')).toMatchObject({
      email: 'ada@example.com',
    });

    await store.createFolder({
      id: 'fld_1',
      name: '測試',
      kind: 'campaigns',
      createdAt: '2026-09-14T00:00:00.000Z',
    });
    expect(backend.saved.at(-1)?.folders).toHaveLength(1);
  });
});

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

function makeCampaign(patch: Partial<Campaign> = {}): Campaign {
  return {
    id: 'cmp_1',
    title: '九月號',
    slug: 'september',
    subject: '九月號',
    bodyMarkdown: '',
    bodyHtml: '<p>舊內文</p>',
    status: 'draft',
    audienceTags: [],
    stats: { total: 0, sent: 0, failed: 0 },
    tracking: EMPTY_TRACKING,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...patch,
  };
}

function makeStarter(id: string, name: string): CampaignStarter {
  return {
    id,
    name,
    description: '測試模板',
    title: '電子報標題',
    preheader: '預覽文字',
    bodyHtml: '<p>內容</p>',
    createdAt: '2026-10-08T00:00:00.000Z',
    updatedAt: '2026-10-08T00:00:00.000Z',
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('快照三方合併', () => {
  it('兩邊動到同一份電子報時做欄位級合併，不會蓋掉寄送狀態', () => {
    const base = emptySnapshot();
    base.campaigns = [makeCampaign()];
    const local = emptySnapshot();
    local.campaigns = [makeCampaign({ bodyHtml: '<p>新內文</p>', updatedAt: '2026-10-08T08:32:09.000Z' })];
    const remote = emptySnapshot();
    remote.campaigns = [makeCampaign({ status: 'sending', updatedAt: '2026-10-08T08:31:22.000Z' })];
    remote.deliveries = [
      { id: 'dlv_1', campaignId: 'cmp_1', subscriberId: 'sub_1', email: 'a@example.com', status: 'pending', attempts: 0 },
    ];

    const merged = mergeSnapshots(base, local, remote);
    expect(merged.campaigns[0]).toMatchObject({
      status: 'sending', // 本地沒改 status → 保留遠端的寄送狀態
      bodyHtml: '<p>新內文</p>', // 本地改的內文帶進來
      updatedAt: '2026-10-08T08:32:09.000Z',
    });
    expect(merged.deliveries).toHaveLength(1); // 遠端剛建立的寄送紀錄不會被清掉
  });

  it('本地沒動的實體用遠端版本，本地的新增與刪除照本地', () => {
    const base = emptySnapshot();
    base.folders = [
      { id: 'fld_keep', name: '保留', kind: 'subscribers', createdAt: '2026-10-01T00:00:00.000Z' },
      { id: 'fld_del', name: '要刪', kind: 'subscribers', createdAt: '2026-10-01T00:00:00.000Z' },
    ];
    const local = emptySnapshot();
    local.folders = [
      base.folders[0]!,
      { id: 'fld_new', name: '新增', kind: 'subscribers', createdAt: '2026-10-08T00:00:00.000Z' },
    ];
    const remote = emptySnapshot();
    remote.folders = [
      { ...base.folders[0]!, name: '遠端改名' },
      base.folders[1]!,
    ];

    const names = mergeSnapshots(base, local, remote).folders.map((f) => f.name).sort();
    expect(names).toEqual(['新增', '遠端改名']);
  });
});

describe('InsForgeStore 多實例並行', () => {
  it('jsonb 逐層重排鍵序後，讀取仍會採納遠端新版本', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-08T00:00:00.000Z'));
      const initial = emptySnapshot();
      initial.campaigns = [makeCampaign()]; // stats / tracking 也會被重排
      initial.settings = { zeta: 'z', alpha: 'a' };
      const backend = fakeBackend(initial, { reorderKeys: true });
      const loaded = await backend.loadSnapshot();
      expect(Object.keys(loaded!.campaigns[0]!.stats)).toEqual(['failed', 'sent', 'total']);

      const writer = new InsForgeStore(backend);
      const reader = new InsForgeStore(backend);
      await writer.init();
      await reader.init();
      await writer.setSetting('fresh', 'remote');

      vi.advanceTimersByTime(3001);
      expect(await reader.getSetting('fresh')).toBe('remote');

      // 第一次採納後的 shadow 也要維持與 snapshot() 同形狀，才能繼續更新。
      await writer.setSetting('second', 'remote-again');
      vi.advanceTimersByTime(3001);
      expect(await reader.getSetting('second')).toBe('remote-again');
    } finally {
      vi.useRealTimers();
    }
  });

  it('另一個實例新增電子報模板後，過 TTL 可讀到並拒絕同名模板', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-08T00:00:00.000Z'));
      const backend = fakeBackend(emptySnapshot(), { reorderKeys: true });
      const writer = new InsForgeStore(backend);
      const reader = new InsForgeStore(backend);
      await writer.init();
      await reader.init();

      await writer.createCampaignStarter(makeStarter('starter_a', '每週精選'));
      vi.advanceTimersByTime(3001);

      expect(await reader.listCampaignStarters()).toMatchObject([{ id: 'starter_a', name: '每週精選' }]);
      await expect(reader.createCampaignStarter(makeStarter('starter_b', '每週精選')))
        .rejects.toThrow('這個模板名稱已被使用');
    } finally {
      vi.useRealTimers();
    }
  });

  it('讀取同步期間產生的本地寫入，遇到遠端再更新也不會遺失', async () => {
    vi.useFakeTimers();
    const readEntered = deferred();
    const releaseRead = deferred();
    const persistEntered = deferred();
    const releasePersist = deferred();
    try {
      vi.setSystemTime(new Date('2026-10-08T00:00:00.000Z'));
      const backend = fakeBackend(emptySnapshot());
      let nextGate: { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | null = null;
      const readerBackend: InsForgeBackend = {
        ...backend,
        async loadSnapshot() {
          const gate = nextGate;
          nextGate = null;
          if (gate) {
            gate.entered.resolve();
            await gate.release.promise;
          }
          return backend.loadSnapshot();
        },
      };
      const writer = new InsForgeStore(backend);
      const reader = new InsForgeStore(readerBackend);
      await writer.init();
      await reader.init();
      await writer.setSetting('remote', 'new');

      vi.advanceTimersByTime(3001);
      nextGate = { entered: readEntered, release: releaseRead };
      const reading = reader.getSetting('remote');
      await readEntered.promise;

      // 讀取的 backend.loadSnapshot 尚未返回時，寫入先改本地 Map，persist 排在讀取後。
      nextGate = { entered: persistEntered, release: releasePersist };
      const writing = reader.setSetting('local', 'mine');
      releaseRead.resolve();
      await persistEntered.promise;

      // 若讀取路徑把未寫入的 local 納入 shadow，這次遠端更新會在三方合併時吃掉 mine。
      await writer.setSetting('local', 'theirs');
      releasePersist.resolve();
      await Promise.all([reading, writing]);

      expect(backend.saved.at(-1)?.settings).toEqual({ remote: 'new', local: 'mine' });
    } finally {
      releaseRead.resolve();
      releasePersist.resolve();
      vi.useRealTimers();
    }
  });

  it('前一筆儲存等待後端時，下一筆本地寫入不會被 adopt 覆蓋', async () => {
    const saveEntered = deferred();
    const releaseSave = deferred();
    try {
      const backend = fakeBackend(emptySnapshot());
      let holdNextSave = false;
      const gatedBackend: InsForgeBackend = {
        ...backend,
        async saveSnapshot(snapshot) {
          if (holdNextSave) {
            holdNextSave = false;
            saveEntered.resolve();
            await releaseSave.promise;
          }
          await backend.saveSnapshot(snapshot);
        },
      };
      const store = new InsForgeStore(gatedBackend);
      await store.init();

      holdNextSave = true;
      const first = store.setSetting('first', 'one');
      await saveEntered.promise;
      const second = store.setSetting('second', 'two');
      releaseSave.resolve();
      await Promise.all([first, second]);

      expect(backend.saved.at(-1)?.settings).toEqual({ first: 'one', second: 'two' });
      expect(await store.getSetting('second')).toBe('two');
    } finally {
      releaseSave.resolve();
    }
  });

  it('舊快照缺少 campaign 預設欄位時，不會永遠誤判為本地改動', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-08T00:00:00.000Z'));
      const initial = emptySnapshot();
      const legacy = makeCampaign();
      delete (legacy as Partial<Campaign>).bodyHtml;
      delete (legacy as Partial<Campaign>).tracking;
      initial.campaigns = [legacy];
      const backend = fakeBackend(initial);
      const writer = new InsForgeStore(backend);
      const reader = new InsForgeStore(backend);
      await writer.init();
      await reader.init();
      await writer.setSetting('fresh', 'normalised');

      vi.advanceTimersByTime(3001);
      expect(await reader.getSetting('fresh')).toBe('normalised');
      expect((await reader.getCampaign('cmp_1'))?.bodyHtml).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('舊實例的自動儲存不會把寄送中的電子報蓋回草稿', async () => {
    const initial = emptySnapshot();
    initial.campaigns = [makeCampaign()];
    const backend = fakeBackend(initial);

    const sender = new InsForgeStore(backend);
    await sender.init();
    const editor = new InsForgeStore(backend); // 另一個 serverless 實例，快照載入後就不新了
    await editor.init();

    // 寄送實例：標成寄送中、建立寄送紀錄
    await sender.updateCampaign('cmp_1', { status: 'sending', updatedAt: '2026-10-08T08:31:22.000Z' });
    await sender.createDeliveries([
      { id: 'dlv_1', campaignId: 'cmp_1', subscriberId: 'sub_1', email: 'a@example.com', status: 'pending', attempts: 0 },
      { id: 'dlv_2', campaignId: 'cmp_1', subscriberId: 'sub_2', email: 'b@example.com', status: 'pending', attempts: 0 },
    ]);

    // 編輯實例（記憶體裡還是草稿）：自動儲存只改內文
    await editor.updateCampaign('cmp_1', { bodyHtml: '<p>新內文</p>', updatedAt: '2026-10-08T08:32:09.000Z' });

    const latest = backend.saved.at(-1)!;
    const campaign = latest.campaigns.find((c) => c.id === 'cmp_1')!;
    expect(campaign.status).toBe('sending'); // 以前這裡會被整包蓋回 draft
    expect(campaign.bodyHtml).toBe('<p>新內文</p>');
    expect(latest.deliveries).toHaveLength(2); // 寄送紀錄不會被舊快照清掉

    // 編輯實例合併後自己也看得到最新狀態
    expect((await editor.getCampaign('cmp_1'))?.status).toBe('sending');
  });

  it('每次寫入版本號遞增，看得出遠端有沒有被別人動過', async () => {
    const backend = fakeBackend(emptySnapshot());
    const store = new InsForgeStore(backend);
    await store.init();
    await store.setSetting('k', '1');
    await store.setSetting('k', '2');
    const versions = backend.saved.map((s) => (s as { __nk_version?: number }).__nk_version);
    expect(versions).toEqual([1, 2]);
  });
});

describe('InsForge email adapter', () => {
  it('沒金鑰時 verify 失敗', async () => {
    const adapter = createInsForgeAdapter({ provider: 'insforge' });
    const result = await adapter.verify();
    expect(result.ok).toBe(false);
  });

  it('有金鑰時 verify 通過', async () => {
    const adapter = createInsForgeAdapter({
      provider: 'insforge',
      insforgeUrl: 'https://example.insforge.app',
      insforgeApiKey: 'key',
    });
    await expect(adapter.verify()).resolves.toMatchObject({ ok: true });
  });
});

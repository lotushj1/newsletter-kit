import { describe, expect, it } from 'vitest';
import { createInsForgeAdapter } from '../src/email/adapters/insforge.js';
import type { InsForgeBackend } from '../src/core/insforge.js';
import { InsForgeStore } from '../src/store/insforge-store.js';
import type { MemorySnapshot } from '../src/store/memory-store.js';

function fakeBackend(initial: MemorySnapshot | null = null): InsForgeBackend & { saved: MemorySnapshot[] } {
  let current = initial;
  const saved: MemorySnapshot[] = [];
  return {
    saved,
    async loadSnapshot() {
      return current;
    },
    async saveSnapshot(snapshot) {
      current = snapshot;
      saved.push(snapshot);
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

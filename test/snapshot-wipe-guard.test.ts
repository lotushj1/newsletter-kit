import { describe, expect, it } from 'vitest';
import type { InsForgeBackend } from '../src/core/insforge.js';
import { InsForgeStore } from '../src/store/insforge-store.js';
import type { MemorySnapshot } from '../src/store/memory-store.js';
import type { Campaign, Delivery, Subscriber } from '../src/store/types.js';
import { EMPTY_TRACKING } from '../src/store/types.js';

/**
 * 寄送中資料被清空的重現情境：
 * 寄送中實例 A 持有完整資料；另一個冷啟動實例 B 讀快照時拿到 null，
 * 舊版 init() 會直接寫入空白資料；接著 A 更新一筆 delivery，三方合併把
 * 「遠端不見了」當成「遠端刪除」，於是名單、電子報、設定全部被刪掉，
 * 只剩 A 剛改的那一筆 delivery。
 */

type Versioned = MemorySnapshot & { __nk_version?: number };

function sharedBackend(initial: Versioned) {
  let current: Versioned | null = structuredClone(initial);
  let nullReadsLeft = 0;
  const writes: Versioned[] = [];
  const make = (): InsForgeBackend => ({
    async loadSnapshot() {
      if (nullReadsLeft > 0) {
        nullReadsLeft -= 1;
        return null; // 模擬 InsForge 短暫回空結果（列其實存在）
      }
      return current ? structuredClone(current) : null;
    },
    async saveSnapshot(snapshot) {
      current = structuredClone(snapshot as Versioned);
      writes.push(structuredClone(snapshot as Versioned));
    },
    async uploadImage(fileName) {
      return { url: `https://files.example/${fileName}` };
    },
    async sendEmail() {
      return { id: 'msg_1' };
    },
  });
  return {
    make,
    writes,
    failNextReads(count: number) {
      nullReadsLeft = count;
    },
    current: () => current,
  };
}

function fullSnapshot(): Versioned {
  const subscribers: Subscriber[] = Array.from({ length: 50 }, (_, i) => ({
    id: `sub_${i}`,
    email: `reader${i}@example.com`,
    status: 'subscribed',
    tags: [],
    createdAt: '2026-11-01T00:00:00.000Z',
  }));
  const campaign: Campaign = {
    id: 'cmp_12',
    slug: '12',
    title: '第 12 期',
    subject: '第 12 期',
    bodyHtml: '<p>hi</p>',
    status: 'sending',
    audienceTags: [],
    createdAt: '2026-11-03T00:00:00.000Z',
    updatedAt: new Date().toISOString(),
    tracking: EMPTY_TRACKING,
  } as unknown as Campaign;
  const deliveries: Delivery[] = subscribers.map((s, i) => ({
    id: `dlv_${i}`,
    campaignId: 'cmp_12',
    subscriberId: s.id,
    email: s.email,
    status: 'pending',
    attempts: 0,
  }));
  return {
    subscribers,
    campaigns: [campaign],
    deliveries,
    events: [],
    sequences: [],
    sequenceSteps: [],
    enrollments: [],
    folders: [{ id: 'fld_1', name: '名單', kind: 'subscribers', createdAt: '2026-11-01T00:00:00.000Z' }],
    templates: [],
    settings: { brand_name: '測試品牌' },
    campaignStarters: [],
    __nk_version: 5000,
  } as Versioned;
}

describe('讀到空值不得把正式資料寫空', () => {
  it('冷啟動讀到 null 時不會寫入空白快照，寄送中實例的寫入也不會刪光資料', async () => {
    const shared = sharedBackend(fullSnapshot());

    const sender = new InsForgeStore(shared.make());
    await sender.init();

    // 冷啟動實例 B 讀到空值（列其實存在）
    shared.failNextReads(1);
    const coldStart = new InsForgeStore(shared.make());
    await expect(coldStart.init()).rejects.toThrow();

    // 寄送中實例照常更新一筆 delivery
    await sender.updateDelivery('dlv_0', { status: 'sent', sentAt: new Date().toISOString() });

    const remote = shared.current()!;
    expect(remote.subscribers).toHaveLength(50);
    expect(remote.campaigns).toHaveLength(1);
    expect(remote.deliveries).toHaveLength(50);
    expect(remote.settings.brand_name).toBe('測試品牌');
    expect(remote.deliveries.find((d) => d.id === 'dlv_0')?.status).toBe('sent');
  });

  it('遠端快照被別的程式寫空時，拒絕合併寫入而不是跟著刪資料', async () => {
    const shared = sharedBackend(fullSnapshot());
    const sender = new InsForgeStore(shared.make());
    await sender.init();

    // 模擬舊版程式或外部工具把整列寫成空白（版本號重置）
    const wiper = shared.make();
    await wiper.saveSnapshot({
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
      __nk_version: 1,
    } as Versioned);

    await expect(
      sender.updateDelivery('dlv_0', { status: 'sent', sentAt: new Date().toISOString() }),
    ).rejects.toThrow(/版本倒退|異常縮減/);

    // 不寫入：遠端仍是被寫空的那一份，等人工從備份還原，不會再被合併弄得更亂
    expect(shared.current()!.__nk_version).toBe(1);
    expect(shared.writes).toHaveLength(1);
    // 之後這個實例的所有寫入都直接拒絕（fail closed）
    await expect(sender.setSetting('x', 'y')).rejects.toThrow(/版本倒退/);
    expect(sender.integrityStatus().ok).toBe(false);
  });

  it('版本號沒倒退、但遠端大量消失（例如被舊合併邏輯刪光）時也會停寫', async () => {
    const shared = sharedBackend(fullSnapshot());
    const sender = new InsForgeStore(shared.make());
    await sender.init();
    const gutted = structuredClone(shared.current()!);
    gutted.subscribers = gutted.subscribers.slice(0, 3);
    gutted.__nk_version = 5001;
    await shared.make().saveSnapshot(gutted);
    await expect(sender.updateDelivery('dlv_0', { status: 'sent' })).rejects.toThrow(/異常縮減/);
    expect(shared.current()!.subscribers).toHaveLength(3);
  });

  it('本地刻意大量刪除時帶標記，其他實例看到標記會放行', async () => {
    const shared = sharedBackend(fullSnapshot());
    const admin = new InsForgeStore(shared.make());
    const other = new InsForgeStore(shared.make());
    await admin.init();
    await other.init();
    for (let i = 0; i < 40; i += 1) await admin.deleteSubscriber(`sub_${i}`);
    expect(shared.current()!.subscribers).toHaveLength(10);
    // 另一個實例接著寫入：大量消失有批次刪除標記，所以正常合併
    await other.setSetting('after', '1');
    expect(shared.current()!.subscribers).toHaveLength(10);
    expect(shared.current()!.settings.after).toBe('1');
  });
});

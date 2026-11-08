import { createHash, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InsForgeTableStore } from '../src/store/insforge-table-store.js';
import { MemoryStore } from '../src/store/memory-store.js';
import { SqliteStore } from '../src/store/sqlite-store.js';
import type { Store } from '../src/store/types.js';
import { PgliteTableDb } from './support/pglite-table-db.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

const factories: [string, () => Promise<Store>][] = [
  ['memory', async () => new MemoryStore()],
  [
    'sqlite',
    async () => {
      const path = join(tmpdir(), `nk-batch-${randomUUID()}.db`);
      cleanups.push(async () => rmSync(path, { force: true }));
      return new SqliteStore(path);
    },
  ],
  [
    'insforge-tables',
    async () => {
      const db = await PgliteTableDb.create();
      cleanups.push(() => db.close());
      return new InsForgeTableStore(db);
    },
  ],
];

describe.each(factories)('整批讀取（%s）', { timeout: 60_000 }, (_name, create) => {
  it('getSubscribersByIds：重複的 id 只回一筆、找不到的略過', async () => {
    const store = await create();
    await store.init();
    for (const i of [1, 2, 3]) {
      await store.createSubscriber({
        id: `sub_${i}`,
        email: `u${i}@example.test`,
        status: i === 2 ? 'unsubscribed' : 'subscribed',
        tags: [],
        createdAt: '2026-11-01T00:00:00.000Z',
      });
    }
    const found = await store.getSubscribersByIds(['sub_3', 'sub_1', 'sub_1', 'sub_missing']);
    expect(found.map((s) => s.id).sort()).toEqual(['sub_1', 'sub_3']);
    expect(await store.getSubscribersByIds([])).toEqual([]);
    await store.close();
  });

  it('getSettings：只回有值的鍵', async () => {
    const store = await create();
    await store.init();
    await store.setSetting('a', '1');
    await store.setSetting('b', '2');
    expect(await store.getSettings(['a', 'b', 'a', 'none'])).toEqual({ a: '1', b: '2' });
    expect(await store.getSettings([])).toEqual({});
    await store.close();
  });

  it('一次查很多個長 key／id 也不會超過網址長度上限（排除名單 key 是 76 字元）', async () => {
    const store = await create();
    await store.init();
    const keys = Array.from({ length: 300 }, (_, i) => `suppression:${createHash('sha256').update(String(i)).digest('hex')}`);
    for (const key of keys.filter((_, i) => i % 7 === 0)) await store.setSetting(key, 'bounce');
    const found = await store.getSettings(keys);
    expect(Object.keys(found)).toHaveLength(keys.filter((_, i) => i % 7 === 0).length);
    const ids = Array.from({ length: 400 }, (_, i) => `sub_${'x'.repeat(30)}_${i}`);
    expect(await store.getSubscribersByIds(ids)).toEqual([]);
    await store.close();
  });
});

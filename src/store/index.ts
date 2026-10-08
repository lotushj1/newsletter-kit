import type { StoreDriver } from '../config.js';
import { InsForgeStore } from './insforge-store.js';
import { JsonStore } from './json-store.js';
import { MemoryStore } from './memory-store.js';
import { SqliteStore } from './sqlite-store.js';
import type { Store } from './types.js';

export { InsForgeStore } from './insforge-store.js';
export { JsonStore } from './json-store.js';
export { MemoryStore } from './memory-store.js';
export { SqliteStore } from './sqlite-store.js';
export type * from './types.js';

export function createStore(driver: StoreDriver, path: string): Store {
  switch (driver) {
    case 'sqlite':
      return new SqliteStore(path);
    case 'json':
      return new JsonStore(path);
    case 'memory':
      return new MemoryStore();
    case 'insforge':
      return new InsForgeStore();
    default: {
      const exhaustive: never = driver;
      throw new Error(`未知的 STORE_DRIVER：${String(exhaustive)}`);
    }
  }
}

import { createInsForgeBackend, type InsForgeBackend } from '../core/insforge.js';
import { logger } from '../core/logger.js';
import { MemoryStore, type MemorySnapshot } from './memory-store.js';

const EMPTY: MemorySnapshot = {
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

/**
 * 把整份資料存在 InsForge 一列 JSON，適合 Vercel 這類沒有持久硬碟的試跑。
 * 名單上萬筆請改 sqlite／自己的 Postgres store。
 */
export class InsForgeStore extends MemoryStore {
  override readonly driver = 'insforge';

  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly backend: InsForgeBackend = createInsForgeBackend()) {
    super();
  }

  override async init(): Promise<void> {
    try {
      const payload = await this.backend.loadSnapshot();
      this.loadSnapshot(payload ?? EMPTY);
      if (!payload) await this.backend.saveSnapshot(this.snapshot());
    } catch (error) {
      logger.error('InsForge 資料讀取失敗', { error: (error as Error).message });
      throw error;
    }
  }

  override async close(): Promise<void> {
    await this.writing;
  }

  protected override async persist(): Promise<void> {
    this.writing = this.writing.then(() => this.backend.saveSnapshot(this.snapshot()));
    await this.writing;
  }
}

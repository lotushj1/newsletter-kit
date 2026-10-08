import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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
 * 單一 JSON 檔案儲存：零原生依賴，適合小名單與試跑。
 * 每次寫入都整檔覆寫，名單上萬筆請改用 sqlite 或自己的資料庫。
 */
export class JsonStore extends MemoryStore {
  override readonly driver = 'json';

  private readonly path: string;
  private writing: Promise<void> = Promise.resolve();

  constructor(path: string) {
    super();
    this.path = resolve(process.cwd(), path);
  }

  override async init(): Promise<void> {
    mkdirSync(dirname(this.path), { recursive: true });
    if (!existsSync(this.path)) {
      this.loadSnapshot(EMPTY);
      this.writeFile();
      return;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<MemorySnapshot>;
      this.loadSnapshot({
        subscribers: parsed.subscribers ?? [],
        campaigns: parsed.campaigns ?? [],
        deliveries: parsed.deliveries ?? [],
        events: parsed.events ?? [],
        sequences: parsed.sequences ?? [],
        sequenceSteps: parsed.sequenceSteps ?? [],
        enrollments: parsed.enrollments ?? [],
        folders: parsed.folders ?? [],
        templates: parsed.templates ?? [],
        settings: parsed.settings ?? {},
        campaignStarters: parsed.campaignStarters ?? [],
      });
    } catch (error) {
      logger.error('JSON 資料檔讀取失敗，改用空資料啟動', {
        path: this.path,
        error: (error as Error).message,
      });
      this.loadSnapshot(EMPTY);
    }
  }

  override async close(): Promise<void> {
    await this.writing;
  }

  protected override async persist(): Promise<void> {
    // 串行化寫入，避免併發請求互相踩到同一個檔案。
    this.writing = this.writing.then(() => {
      this.writeFile();
    });
    await this.writing;
  }

  private writeFile(): void {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.snapshot(), null, 2), 'utf8');
    renameSync(tmp, this.path);
  }
}

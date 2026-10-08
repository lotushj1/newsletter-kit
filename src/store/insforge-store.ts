import { isDeepStrictEqual } from 'node:util';
import { createInsForgeBackend, type InsForgeBackend } from '../core/insforge.js';
import { logger } from '../core/logger.js';
import { MemoryStore, type MemorySnapshot } from './memory-store.js';
import { mergeSnapshots } from './snapshot-merge.js';

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

/** 遠端 payload 夾帶的版本號；舊資料沒有這個欄位（視為 0）。 */
type VersionedSnapshot = MemorySnapshot & { __nk_version?: number };

/** 讀取超過這個毫秒數就先跟遠端同步一次，避免 serverless 多實例各看各的舊資料。 */
const READ_TTL_MS = 3000;

/** 這些讀取方法在執行前會先確認快照夠新。 */
const READ_METHODS = [
  'getSubscriber',
  'getSubscriberByEmail',
  'listSubscribers',
  'listSubscriberTags',
  'countSubscribersByStatus',
  'countSubscribersByFolder',
  'listAudience',
  'getFolder',
  'listFolders',
  'countCampaignsByFolder',
  'getCampaign',
  'getCampaignBySlug',
  'listCampaigns',
  'findDueCampaigns',
  'findSendingCampaigns',
  'listDeliveries',
  'deliveryStats',
  'findDeliveryByProviderMessageId',
  'campaignTrackingStats',
  'periodStats',
  'getSequence',
  'listSequences',
  'listSequenceSteps',
  'getEnrollment',
  'listEnrollments',
  'findDueEnrollments',
  'getTemplate',
  'listTemplates',
  'getSetting',
  'getCampaignStarter',
  'listCampaignStarters',
] as const;

/**
 * 把整份資料存在 InsForge 一列 JSON，適合 Vercel 這類沒有持久硬碟的試跑。
 * 名單上萬筆請改 sqlite／自己的 Postgres store。
 *
 * Serverless 會同時有多個實例各自持有一份記憶體快照，所以：
 * - 每次寫入前先抓遠端最新快照做三方合併（見 snapshot-merge.ts），
 *   不讓舊實例整包蓋掉別人剛寫入的狀態（例如寄送中的電子報被蓋回草稿）。
 * - 讀取超過 READ_TTL_MS 就先同步一次，縮短跨實例看到舊資料的時間。
 * - payload 夾帶遞增版本號判斷遠端有沒有被別人動過。
 * 讀改寫之間仍有幾毫秒的競態窗口（InsForge 沒有條件更新可用），
 * 但已從「實例整個生命週期」縮到單次請求往返。
 */
export class InsForgeStore extends MemoryStore {
  override readonly driver = 'insforge';

  /** 上次同步時遠端的版本號。 */
  private version = 0;
  /** 上次同步後的快照，三方合併的 base。 */
  private shadow: MemorySnapshot = EMPTY;
  private lastSyncAt = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly backend: InsForgeBackend = createInsForgeBackend()) {
    super();
    for (const name of READ_METHODS) {
      const original = (this as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[
        name
      ]!.bind(this);
      (this as unknown as Record<string, unknown>)[name] = async (...args: unknown[]) => {
        await this.refreshIfStale();
        return original(...args);
      };
    }
  }

  override async init(): Promise<void> {
    try {
      const payload = (await this.backend.loadSnapshot()) as VersionedSnapshot | null;
      if (payload) {
        this.adopt(payload, payload.__nk_version ?? 0);
      } else {
        this.adopt(EMPTY, await this.saveVersioned(EMPTY));
      }
    } catch (error) {
      logger.error('InsForge 資料讀取失敗', { error: (error as Error).message });
      throw error;
    }
  }

  override async close(): Promise<void> {
    await this.queue;
  }

  protected override async persist(): Promise<void> {
    await this.enqueue(() => this.sync(true));
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async refreshIfStale(): Promise<void> {
    if (Date.now() - this.lastSyncAt < READ_TTL_MS) return;
    await this.enqueue(async () => {
      if (Date.now() - this.lastSyncAt < READ_TTL_MS) return;
      try {
        await this.sync(false);
      } catch (error) {
        // 讀取時同步失敗就先用手上的快照，寫入時的同步會再試一次。
        logger.warn('InsForge 快照同步失敗，暫用本地快照', { error: (error as Error).message });
        this.lastSyncAt = Date.now();
      }
    });
  }

  /** 讀遠端 → 三方合併 → （write 時）存回去，一律在 queue 裡序列化執行。 */
  private async sync(write: boolean): Promise<void> {
    const payload = (await this.backend.loadSnapshot()) as VersionedSnapshot | null;
    const remoteVersion = payload?.__nk_version ?? 0;
    const local = this.snapshot();

    if (!write) {
      if (!payload || remoteVersion === this.version) {
        this.lastSyncAt = Date.now();
        return;
      }
      // shadow 與 local 都是 loadSnapshot 後的形狀；物件鍵序不代表本地修改。
      // 真有未寫回的修改時保留舊 base，讓接續的 persist 做三方合併。
      if (!isDeepStrictEqual(local, this.shadow)) return;
      this.adopt(payload, remoteVersion);
      return;
    }

    const merged =
      payload && remoteVersion !== this.version
        ? mergeSnapshots(this.shadow, local, payload)
        : local;
    const nextVersion = await this.saveVersioned(merged, Math.max(this.version, remoteVersion));
    // saveSnapshot 等待期間另一個寫入可能已修改 Map，但它的 persist 還排在 queue 後面。
    // 先記下這段期間的改動，再讓 adopt 更新已存檔的 base，避免覆蓋尚未寫回的修改。
    const latestLocal = this.snapshot();
    this.adopt(merged, nextVersion);
    if (!isDeepStrictEqual(local, latestLocal)) {
      this.loadSnapshot(mergeSnapshots(local, latestLocal, this.shadow));
    }
  }

  private async saveVersioned(snapshot: MemorySnapshot, baseVersion = 0): Promise<number> {
    const nextVersion = baseVersion + 1;
    const payload: VersionedSnapshot = { ...snapshot, __nk_version: nextVersion };
    await this.backend.saveSnapshot(payload);
    return nextVersion;
  }

  private adopt(snapshot: MemorySnapshot, version: number): void {
    const { __nk_version: _ignored, ...pure } = snapshot as VersionedSnapshot;
    this.loadSnapshot(pure as MemorySnapshot);
    // 三方合併的 base 必須與 snapshot() 同形狀，包含 loadSnapshot 補上的預設欄位。
    this.shadow = structuredClone(this.snapshot());
    this.version = version;
    this.lastSyncAt = Date.now();
  }
}

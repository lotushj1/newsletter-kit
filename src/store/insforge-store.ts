import { isDeepStrictEqual } from 'node:util';
import { createInsForgeBackend, type InsForgeBackend } from '../core/insforge.js';
import { logger } from '../core/logger.js';
import { MemoryStore, type MemorySnapshot } from './memory-store.js';
import { mergeSnapshots } from './snapshot-merge.js';
import {
  SnapshotConflictError,
  SnapshotIntegrityError,
  assertSnapshotShape,
  detectRemoteLoss,
  recordDeletions,
  snapshotCounts,
  type Tombstones,
} from './snapshot-guard.js';
import type { DeliveryClaim } from './types.js';

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
 * 遠端 payload 夾帶的中繼欄位：
 * - __nk_version：每次寫入遞增，用來做條件更新（compare-and-swap）。
 * - __nk_tombstones：最近被刪掉的 id 與版本號。別的實例看到資料消失時，
 *   有墓碑代表是正常刪除；沒有墓碑的大量消失就是遠端損毀。
 */
type VersionedSnapshot = MemorySnapshot & {
  __nk_version?: number;
  __nk_tombstones?: Tombstones;
};

/** 讀取超過這個毫秒數就先跟遠端同步一次，避免 serverless 多實例各看各的舊資料。 */
const READ_TTL_MS = 3000;
/** 條件更新衝突時最多重讀合併幾次。 */
const MAX_CAS_ATTEMPTS = 5;
/** 歷史版本保留份數（每小時一份 ≈ 3 天）。 */
const HISTORY_KEEP = 72;

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
  'listTrackingEvents',
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
 * 資料安全防護（見 docs/data-safety.md）：
 * - 讀到 null 時先確認資料列是否真的不存在；存在就丟錯，絕不寫入空白資料。
 *   全新安裝也只用「只新增」建立，不可能覆寫既有資料。
 * - 寫入一律做條件更新：遠端版本號必須等於剛讀到的版本，否則重讀再合併。
 * - 合併前檢查遠端有沒有「大量消失、而且不是有標記的批次刪除」或版本倒退；
 *   有的話視為遠端損毀，這個實例停止寫入（fail closed），等人工處理。
 * - 每小時留一份歷史版本（同表 history-YYYYMMDDHH），只新增不覆寫。
 */
export class InsForgeStore extends MemoryStore {
  override readonly driver = 'insforge';

  /** 上次同步時遠端的版本號。 */
  private version = 0;
  /** 上次同步後的快照，三方合併的 base。 */
  private shadow: MemorySnapshot = EMPTY;
  private lastSyncAt = 0;
  private lastHistoryKey = '';
  private queue: Promise<unknown> = Promise.resolve();
  /** 偵測到遠端損毀後就不再寫入，直到程序重啟並由人工確認資料。 */
  private integrityError: SnapshotIntegrityError | null = null;

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

  /** 給 /health 與寄送迴圈判斷：資料層是否已因完整性問題停寫。 */
  integrityStatus(): { ok: boolean; reason?: string } {
    return this.integrityError ? { ok: false, reason: this.integrityError.message } : { ok: true };
  }

  override async init(): Promise<void> {
    try {
      const payload = (await this.backend.loadSnapshot()) as VersionedSnapshot | null;
      if (payload) {
        assertSnapshotShape(payload, '啟動讀取');
        this.adopt(payload, payload.__nk_version ?? 0);
        return;
      }
      await this.initMissingRow();
    } catch (error) {
      logger.error('InsForge 資料讀取失敗', { error: (error as Error).message });
      throw error;
    }
  }

  /** 讀到 null：先確認是不是真的沒有資料列，絕不在「讀取異常」時寫入空白資料。 */
  private async initMissingRow(): Promise<void> {
    if (this.backend.snapshotExists) {
      const exists = await this.backend.snapshotExists();
      if (exists) {
        throw new SnapshotIntegrityError(
          '讀取快照得到空值，但資料列其實存在；為避免覆寫正式資料，拒絕啟動',
        );
      }
    } else {
      // 沒有辦法確認資料列是否存在的後端（舊版自訂實作）：再讀一次，仍是 null 才建立。
      const again = await this.backend.loadSnapshot();
      if (again) {
        throw new SnapshotIntegrityError('連續兩次讀取結果不一致，拒絕啟動以免覆寫正式資料');
      }
    }
    const initial: VersionedSnapshot = { ...EMPTY, __nk_version: 1 };
    if (this.backend.createSnapshot) {
      // 只新增：資料列已存在（例如另一個實例剛建好）時會失敗，不會覆寫。
      await this.backend.createSnapshot(initial);
    } else {
      await this.backend.saveSnapshot(initial);
    }
    this.adopt(initial, 1);
  }

  override async close(): Promise<void> {
    await this.queue;
  }

  protected override async persist(): Promise<void> {
    this.assertWritable();
    await this.enqueue(() => this.writeWithRetry(() => undefined));
  }

  /**
   * 原子地領走 pending 寄送紀錄：在同一次條件更新裡以遠端最新狀態為準、
   * 只領仍是 pending 的那些；版本衝突就撤銷這次領取、重讀再試。
   */
  override async claimDeliveries(ids: string[], claim: DeliveryClaim): Promise<string[]> {
    this.assertWritable();
    return this.enqueue(() => this.writeWithRetry(() => this.claimDeliveriesInMemory(ids, claim)));
  }

  private assertWritable(): void {
    if (this.integrityError) throw this.integrityError;
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
        await this.refresh();
      } catch (error) {
        if (error instanceof SnapshotIntegrityError) {
          this.freeze(error);
        } else {
          // 讀取時同步失敗就先用手上的快照，寫入時的同步會再試一次。
          logger.warn('InsForge 快照同步失敗，暫用本地快照', { error: (error as Error).message });
        }
        this.lastSyncAt = Date.now();
      }
    });
  }

  private freeze(error: SnapshotIntegrityError): void {
    if (!this.integrityError) {
      logger.error('InsForge 快照完整性異常，這個實例停止寫入', {
        error: error.message,
        ...error.details,
      });
    }
    this.integrityError = error;
  }

  /** 讀遠端；遠端有新版本、本地沒有未寫回的修改時採用遠端。 */
  private async refresh(): Promise<void> {
    const payload = await this.loadRemote('同步讀取');
    if (!payload) {
      this.lastSyncAt = Date.now();
      return;
    }
    const remoteVersion = payload.__nk_version ?? 0;
    if (remoteVersion === this.version) {
      this.lastSyncAt = Date.now();
      return;
    }
    const local = this.snapshot();
    this.guard(local, payload, remoteVersion);
    // shadow 與 local 都是 loadSnapshot 後的形狀；物件鍵序不代表本地修改。
    // 真有未寫回的修改時保留舊 base，讓接續的 persist 做三方合併。
    if (!isDeepStrictEqual(local, this.shadow)) return;
    this.adopt(payload, remoteVersion);
  }

  private async loadRemote(where: string): Promise<VersionedSnapshot | null> {
    const payload = (await this.backend.loadSnapshot()) as VersionedSnapshot | null;
    if (!payload) {
      // 已經有資料的實例讀到 null：一定是讀取異常或資料列被刪，不能當成「遠端是空的」。
      if (this.version > 0 || !isDeepStrictEqual(this.shadow, EMPTY)) {
        throw new SnapshotIntegrityError(`${where}：遠端快照讀到空值，拒絕合併與寫入`, {
          localVersion: this.version,
        });
      }
      return null;
    }
    assertSnapshotShape(payload, where);
    return payload;
  }

  /** 版本倒退、或遠端大量消失又沒有批次刪除標記 → 遠端損毀。 */
  private guard(local: MemorySnapshot, remote: VersionedSnapshot, remoteVersion: number): void {
    if (remoteVersion < this.version) {
      throw new SnapshotIntegrityError(
        `遠端快照版本倒退（本地 ${this.version} → 遠端 ${remoteVersion}），疑似被舊程式或空白資料覆寫`,
        { localVersion: this.version, remoteVersion, remoteCounts: snapshotCounts(remote) },
      );
    }
    const losses = detectRemoteLoss(this.shadow, local, remote, {
      tombstones: remote.__nk_tombstones,
      sinceVersion: this.version,
    });
    if (losses.length === 0) return;
    throw new SnapshotIntegrityError('遠端快照資料異常縮減（integrity），拒絕合併與寫入', {
      localVersion: this.version,
      remoteVersion,
      losses,
      remoteCounts: snapshotCounts(remote),
    });
  }

  /**
   * 讀遠端 → 檢查 → 三方合併 → 套用 mutate → 條件更新。
   * 衝突時撤銷 mutate 與 rebase、重讀再來，所以 mutate 必須可以重跑。
   */
  private async writeWithRetry<T>(mutate: () => T): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      const local = this.snapshot();
      let payload: VersionedSnapshot | null;
      try {
        payload = await this.loadRemote('寫入前讀取');
        if (payload) this.guard(local, payload, payload.__nk_version ?? 0);
      } catch (error) {
        if (error instanceof SnapshotIntegrityError) this.freeze(error);
        throw error;
      }
      const remoteVersion = payload?.__nk_version ?? 0;

      // 先把本地修改 rebase 到遠端最新版本上。
      const rebased =
        payload && remoteVersion !== this.version ? mergeSnapshots(this.shadow, local, payload) : local;
      this.loadSnapshot(rebased);
      const result = mutate();
      const merged = this.snapshot();
      const nextVersion = Math.max(this.version, remoteVersion) + 1;

      const outgoing: VersionedSnapshot = {
        ...merged,
        __nk_version: nextVersion,
        __nk_tombstones: recordDeletions(
          payload?.__nk_tombstones,
          payload ? this.normalize(payload) : this.shadow,
          merged,
          nextVersion,
        ),
      };

      try {
        await this.maybeSaveHistory(payload);
        await this.backend.saveSnapshot(outgoing, {
          expectedVersion: payload ? remoteVersion : undefined,
        });
      } catch (error) {
        if (error instanceof SnapshotConflictError) {
          // 別人先寫了：撤銷這次 rebase 與 mutate（等待期間進來的其他修改保留），重讀再合併。
          const current = this.snapshot();
          this.loadSnapshot(
            isDeepStrictEqual(current, merged) ? local : mergeSnapshots(merged, current, local),
          );
          if (attempt < MAX_CAS_ATTEMPTS) continue;
        }
        throw error;
      }

      // saveSnapshot 等待期間另一個呼叫可能已修改 Map（它的 persist 還排在 queue 後面），
      // 先記下這段期間的改動，再讓 adopt 更新已存檔的 base，避免覆蓋尚未寫回的修改。
      const latestLocal = this.snapshot();
      this.adopt(outgoing, nextVersion);
      if (!isDeepStrictEqual(merged, latestLocal)) {
        this.loadSnapshot(mergeSnapshots(merged, latestLocal, this.shadow));
      }
      return result;
    }
  }

  /** 每小時第一次寫入前，把遠端「寫入前」的狀態另存一份歷史版本。失敗只記錄、不擋寫入。 */
  private async maybeSaveHistory(payload: VersionedSnapshot | null): Promise<void> {
    if (!payload || !this.backend.saveHistory) return;
    const key = new Date().toISOString().slice(0, 13).replace(/[-T:]/g, '');
    if (key === this.lastHistoryKey) return;
    try {
      await this.backend.saveHistory(key, payload, HISTORY_KEEP);
      this.lastHistoryKey = key;
    } catch (error) {
      logger.warn('InsForge 歷史版本寫入失敗', { error: (error as Error).message });
    }
  }

  /** 遠端 payload 補上 loadSnapshot 的預設欄位，才能跟 snapshot() 比較。 */
  private normalize(snapshot: MemorySnapshot): MemorySnapshot {
    const probe = new MemoryStore() as unknown as {
      loadSnapshot(s: MemorySnapshot): void;
      snapshot(): MemorySnapshot;
    };
    probe.loadSnapshot(snapshot);
    return probe.snapshot();
  }

  private adopt(snapshot: MemorySnapshot, version: number): void {
    const { __nk_version: _v, __nk_tombstones: _t, ...pure } = snapshot as VersionedSnapshot;
    this.loadSnapshot(pure as MemorySnapshot);
    // 三方合併的 base 必須與 snapshot() 同形狀，包含 loadSnapshot 補上的預設欄位。
    this.shadow = structuredClone(this.snapshot());
    this.version = version;
    this.lastSyncAt = Date.now();
  }
}

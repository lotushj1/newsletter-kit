import { isDeepStrictEqual } from 'node:util';
import { conflict } from '../core/errors.js';
import { logger } from '../core/logger.js';
import {
  chunk,
  chunkByLength,
  isUniqueViolation,
  likeContains,
  selectAllBySeq,
  type Filter,
  type TableDb,
} from './table-db.js';
import {
  SETTINGS_TABLE,
  SPECS,
  fromRow,
  mergeExtra,
  patchToRow,
  toRow,
  type EntitySpec,
  type Row,
} from './table-mapping.js';
import type {
  AudienceQuery,
  Campaign,
  CampaignQuery,
  CampaignStarter,
  CampaignStats,
  ContentTemplate,
  Delivery,
  DeliveryClaim,
  DeliveryStatus,
  DeliveryUpdate,
  Folder,
  FolderKind,
  Paged,
  PeriodQuery,
  PeriodStats,
  Sequence,
  SequenceEnrollment,
  SequenceStep,
  Store,
  Subscriber,
  SubscriberQuery,
  SubscriberStatus,
  TrackingEvent,
  TrackingStats,
} from './types.js';

/** 跟 migrations/20261108130000_create-nk-entity-tables.sql 的 nk_tables_schema_version() 對齊。 */
export const TABLES_SCHEMA_VERSION = 1;

/** 一次請求寫入的寄送紀錄上限（實測 5,000 筆約 1MB 可一次寫入）。 */
const DELIVERY_INSERT_CHUNK = 5000;
/** 一次 RPC 寫回的寄送結果上限。 */
const DELIVERY_UPDATE_CHUNK = 1000;

interface StatsRow {
  total: number;
  sent: number;
  failed: number;
  unconfirmed: number;
  opens: number;
  uniqueOpens: number;
  clicks: number;
  uniqueClicks: number;
  unsubscribes: number;
  orphanEvents: number;
}

const ZERO_STATS: StatsRow = {
  total: 0,
  sent: 0,
  failed: 0,
  unconfirmed: 0,
  opens: 0,
  uniqueOpens: 0,
  clicks: 0,
  uniqueClicks: 0,
  unsubscribes: 0,
  orphanEvents: 0,
};

function deliveryStatsOf(row: StatsRow): CampaignStats {
  return { total: row.total, sent: row.sent, failed: row.failed, unconfirmed: row.unconfirmed };
}

function trackingOf(row: StatsRow): TrackingStats {
  return {
    opens: row.opens,
    uniqueOpens: row.uniqueOpens,
    clicks: row.clicks,
    uniqueClicks: row.uniqueClicks,
    unsubscribes: row.unsubscribes,
    orphanEvents: row.orphanEvents,
  };
}

const eq = (col: string, value: string | number | boolean): Filter => ({ col, op: 'eq', value });

/** 跟 MemoryStore 一樣：名稱排序用 zh-Hant。 */
const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name, 'zh-Hant');

/**
 * InsForge（Postgres）逐表 store：每種實體一張表，逐列讀寫。
 *
 * 跟 InsForgeStore（整份資料一列 JSON）的差別：
 * - 每次讀寫只碰相關的列，不再整份讀出、合併、整份寫回，名單變大也不會變慢。
 * - 沒有記憶體快照：多個 serverless 實例讀到的都是資料庫當下的資料，不會互相覆寫。
 * - 領取寄送紀錄（claimDeliveries）是一個條件更新：只有仍是 pending 的列會被改成 sending，
 *   同一列只會被一個寄送程序領到。
 * - 多步驟的寫入（刪除電子報連同寄送紀錄、整批替換序列步驟）在資料庫函式裡一次完成。
 */
export class InsForgeTableStore implements Store {
  readonly driver = 'insforge-tables';

  private readonly db: TableDb;
  private readonly deliveryInsertChunk: number;

  constructor(db: TableDb, options: { deliveryInsertChunk?: number } = {}) {
    this.db = db;
    this.deliveryInsertChunk = options.deliveryInsertChunk ?? DELIVERY_INSERT_CHUNK;
  }

  async init(): Promise<void> {
    let version: unknown;
    try {
      version = await this.db.rpc('nk_tables_schema_version');
    } catch (error) {
      throw new Error(
        `InsForge 資料表尚未建立或無法連線（${(error as Error).message}）。` +
          '請先套用 migrations/20261108130000_create-nk-entity-tables.sql。',
      );
    }
    if (Number(version) !== TABLES_SCHEMA_VERSION) {
      throw new Error(
        `InsForge 資料表版本 ${String(version)} 與程式需要的 ${TABLES_SCHEMA_VERSION} 不符，請先套用最新的 migrations。`,
      );
    }
  }

  async close(): Promise<void> {}

  // ── 共用 ────────────────────────────────────────────────
  private async findOne<T>(spec: EntitySpec, filters: Filter[]): Promise<T | null> {
    const rows = await this.db.select<Row>(spec.table, {
      filters,
      order: [{ col: 'seq', ascending: true }],
      limit: 1,
    });
    return rows[0] ? fromRow<T>(spec, rows[0]) : null;
  }

  private async findAll<T>(spec: EntitySpec, filters: Filter[] = [], limit?: number): Promise<T[]> {
    const rows = await selectAllBySeq<Row>(this.db, spec.table, { filters, limit });
    return rows.map((row) => fromRow<T>(spec, row));
  }

  /**
   * 部分更新：只寫 patch 裡出現的欄位。patch 帶到沒有正式欄位的鍵時，
   * 才先讀出該列的 extra 合併後一起寫回。回傳更新後的實體，找不到就回 null。
   */
  private async patchRow<T>(spec: EntitySpec, id: string, patch: object): Promise<T | null> {
    const { columns, extra } = patchToRow(spec, patch);
    if (extra) {
      const current = await this.db.select<Row>(spec.table, {
        filters: [eq(spec.key, id)],
        columns: 'extra',
        limit: 1,
      });
      if (!current[0]) return null;
      columns.extra = mergeExtra(current[0].extra, extra);
    }
    if (Object.keys(columns).length === 0) {
      return this.findOne<T>(spec, [eq(spec.key, id)]);
    }
    const rows = await this.db.update<Row>(spec.table, columns, [eq(spec.key, id)]);
    return rows[0] ? fromRow<T>(spec, rows[0]) : null;
  }

  /**
   * 新增一列。唯一鍵衝突時先看同 id 的列是否已存在（上一次逾時其實已寫入、重試才撞到），
   * 是的話視為成功；否則交給呼叫端轉成對使用者的錯誤訊息。
   */
  private async insertOne(spec: EntitySpec, entity: object): Promise<'inserted' | 'existed'> {
    const row = toRow(spec, entity);
    try {
      await this.db.insert(spec.table, [row]);
      return 'inserted';
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const id = (entity as Record<string, unknown>)[spec.key];
      if (typeof id === 'string') {
        const existing = await this.db.select<Row>(spec.table, { filters: [eq(spec.key, id)], limit: 1 });
        if (existing[0] && sameWrite(row, existing[0])) return 'existed';
      }
      throw error;
    }
  }

  // ── subscribers ─────────────────────────────────────────
  async createSubscriber(subscriber: Subscriber): Promise<Subscriber> {
    try {
      await this.insertOne(SPECS.subscribers, subscriber);
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('這個 Email 已在名單內');
      throw error;
    }
    return structuredClone(subscriber);
  }

  async updateSubscriber(id: string, patch: Partial<Subscriber>): Promise<Subscriber | null> {
    try {
      return await this.patchRow<Subscriber>(SPECS.subscribers, id, patch);
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('這個 Email 已在名單內');
      throw error;
    }
  }

  getSubscriber(id: string): Promise<Subscriber | null> {
    return this.findOne<Subscriber>(SPECS.subscribers, [eq('id', id)]);
  }

  getSubscriberByEmail(email: string): Promise<Subscriber | null> {
    return this.findOne<Subscriber>(SPECS.subscribers, [eq('email', email.toLowerCase())]);
  }

  async getSubscribersByIds(ids: string[]): Promise<Subscriber[]> {
    const out: Subscriber[] = [];
    for (const part of chunkByLength([...new Set(ids)])) {
      const rows = await this.db.select<Row>(SPECS.subscribers.table, { filters: [{ col: 'id', op: 'in', value: part }] });
      out.push(...rows.map((row) => fromRow<Subscriber>(SPECS.subscribers, row)));
    }
    return out;
  }

  async listSubscribers(query: SubscriberQuery = {}): Promise<Paged<Subscriber>> {
    const filters: Filter[] = [];
    if (query.status) filters.push(eq('status', query.status));
    if (query.tag) filters.push({ col: 'tags', op: 'cs', value: [query.tag.toLowerCase()] });
    if (query.folderId === 'unfiled') filters.push({ col: 'folder_id', op: 'is', value: null });
    else if (query.folderId) filters.push(eq('folder_id', query.folderId));
    if (query.search) filters.push({ col: 'search_text', op: 'ilike', value: likeContains(query.search.toLowerCase()) });
    const [total, rows] = await Promise.all([
      this.db.count(SPECS.subscribers.table, filters),
      this.db.select<Row>(SPECS.subscribers.table, {
        filters,
        order: [
          { col: 'created_at', ascending: false },
          { col: 'seq', ascending: true },
        ],
        limit: query.limit ?? 50,
        offset: query.offset ?? 0,
      }),
    ]);
    return { items: rows.map((row) => fromRow<Subscriber>(SPECS.subscribers, row)), total };
  }

  async listSubscriberTags(): Promise<string[]> {
    const tags = await this.db.rpc<string[] | null>('nk_subscriber_tags');
    return [...(tags ?? [])].sort();
  }

  async deleteSubscriber(id: string): Promise<boolean> {
    return (await this.db.delete(SPECS.subscribers.table, [eq('id', id)])) > 0;
  }

  private groupCounts(): Promise<{
    subscriberStatus: Record<string, number>;
    subscriberFolder: Record<string, number>;
    campaignFolder: Record<string, number>;
  }> {
    return this.db.rpc('nk_group_counts');
  }

  async countSubscribersByStatus(): Promise<Record<SubscriberStatus, number>> {
    const counts: Record<SubscriberStatus, number> = { pending: 0, subscribed: 0, unsubscribed: 0, bounced: 0 };
    const { subscriberStatus } = await this.groupCounts();
    for (const [status, n] of Object.entries(subscriberStatus)) {
      if (status in counts) counts[status as SubscriberStatus] = Number(n);
    }
    return counts;
  }

  async countSubscribersByFolder(): Promise<Record<string, number>> {
    const { subscriberFolder } = await this.groupCounts();
    const counts: Record<string, number> = { '': 0 };
    for (const [folderId, n] of Object.entries(subscriberFolder)) counts[folderId] = Number(n);
    return counts;
  }

  async listAudience(query: AudienceQuery = {}): Promise<Subscriber[]> {
    const filters: Filter[] = [eq('status', 'subscribed')];
    if (query.folderId === 'unfiled') filters.push({ col: 'folder_id', op: 'is', value: null });
    else if (query.folderId) filters.push(eq('folder_id', query.folderId));
    const wanted = (query.tags ?? []).map((t) => t.toLowerCase());
    if (wanted.length > 0) filters.push({ col: 'tags', op: 'ov', value: wanted });
    const subscribers = await this.findAll<Subscriber>(SPECS.subscribers, filters);
    // 依寫入順序讀出後穩定排序，同一時間建立的人順序與 MemoryStore 相同。
    return subscribers.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  // ── folders ─────────────────────────────────────────────
  private async folderNameTaken(name: string, kind: FolderKind, exceptId?: string): Promise<boolean> {
    const target = name.trim().toLowerCase();
    const folders = await this.findAll<Folder>(SPECS.folders, [eq('kind', kind)]);
    return folders.some((f) => f.name.toLowerCase() === target && f.id !== exceptId);
  }

  async createFolder(folder: Folder): Promise<Folder> {
    const next: Folder = { ...folder, kind: folder.kind ?? 'subscribers' };
    if (await this.folderNameTaken(next.name, next.kind)) throw conflict('這個資料夾名稱已被使用');
    await this.insertOne(SPECS.folders, next);
    return structuredClone(next);
  }

  async updateFolder(id: string, patch: Partial<Folder>): Promise<Folder | null> {
    const current = await this.getFolder(id);
    if (!current) return null;
    if (patch.name && (await this.folderNameTaken(patch.name, current.kind, id))) {
      throw conflict('這個資料夾名稱已被使用');
    }
    const { kind: _kind, ...rest } = patch;
    return this.patchRow<Folder>(SPECS.folders, id, rest);
  }

  getFolder(id: string): Promise<Folder | null> {
    return this.findOne<Folder>(SPECS.folders, [eq('id', id)]);
  }

  async listFolders(kind: FolderKind = 'subscribers'): Promise<Folder[]> {
    return (await this.findAll<Folder>(SPECS.folders, [eq('kind', kind)])).sort(byName);
  }

  async deleteFolder(id: string): Promise<boolean> {
    return Boolean(await this.db.rpc<boolean>('nk_delete_folder', { p_id: id }));
  }

  async countCampaignsByFolder(): Promise<Record<string, number>> {
    const { campaignFolder } = await this.groupCounts();
    const counts: Record<string, number> = {};
    for (const [folderId, n] of Object.entries(campaignFolder)) counts[folderId] = Number(n);
    return counts;
  }

  // ── campaigns ───────────────────────────────────────────
  private async statsFor(ids: string[]): Promise<Map<string, StatsRow>> {
    const out = new Map<string, StatsRow>();
    if (ids.length === 0) return out;
    for (const part of chunk([...new Set(ids)], 500)) {
      const stats = await this.db.rpc<Record<string, Partial<StatsRow>> | null>('nk_campaign_stats', {
        p_campaign_ids: part,
      });
      for (const [id, row] of Object.entries(stats ?? {})) {
        const normalized = { ...ZERO_STATS };
        for (const key of Object.keys(ZERO_STATS) as (keyof StatsRow)[]) normalized[key] = Number(row[key] ?? 0);
        out.set(id, normalized);
      }
    }
    return out;
  }

  private async hydrate(rows: Row[]): Promise<Campaign[]> {
    const campaigns = rows.map((row) => fromRow<Campaign>(SPECS.campaigns, row));
    const stats = await this.statsFor(campaigns.map((c) => c.id));
    return campaigns.map((campaign) => {
      const row = stats.get(campaign.id) ?? ZERO_STATS;
      return { ...campaign, stats: deliveryStatsOf(row), tracking: trackingOf(row) };
    });
  }

  private async findCampaign(filters: Filter[]): Promise<Campaign | null> {
    const rows = await this.db.select<Row>(SPECS.campaigns.table, { filters, limit: 1 });
    if (!rows[0]) return null;
    return (await this.hydrate([rows[0]]))[0] ?? null;
  }

  async createCampaign(campaign: Campaign): Promise<Campaign> {
    try {
      await this.insertOne(SPECS.campaigns, campaign);
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('這個 slug 已被使用');
      throw error;
    }
    return (await this.getCampaign(campaign.id)) ?? {
      ...structuredClone(campaign),
      bodyHtml: campaign.bodyHtml ?? '',
      stats: deliveryStatsOf(ZERO_STATS),
      tracking: trackingOf(ZERO_STATS),
    };
  }

  async updateCampaign(id: string, patch: Partial<Campaign>): Promise<Campaign | null> {
    let updated: Campaign | null;
    try {
      updated = await this.patchRow<Campaign>(SPECS.campaigns, id, patch);
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('這個 slug 已被使用');
      throw error;
    }
    if (!updated) return null;
    const row = (await this.statsFor([id])).get(id) ?? ZERO_STATS;
    return { ...updated, stats: deliveryStatsOf(row), tracking: trackingOf(row) };
  }

  getCampaign(id: string): Promise<Campaign | null> {
    return this.findCampaign([eq('id', id)]);
  }

  getCampaignBySlug(slug: string): Promise<Campaign | null> {
    return this.findCampaign([eq('slug', slug)]);
  }

  async listCampaigns(query: CampaignQuery = {}): Promise<Paged<Campaign>> {
    const filters: Filter[] = [];
    if (query.status) filters.push(eq('status', query.status));
    if (query.search) filters.push({ col: 'search_text', op: 'ilike', value: likeContains(query.search.toLowerCase()) });
    if (query.from) filters.push({ col: 'when_at', op: 'gte', value: query.from });
    if (query.to) filters.push({ col: 'when_at', op: 'lte', value: query.to });
    if (query.folderId === 'unfiled') filters.push({ col: 'folder_id', op: 'is', value: null });
    else if (query.folderId) filters.push(eq('folder_id', query.folderId));
    const [total, rows] = await Promise.all([
      this.db.count(SPECS.campaigns.table, filters),
      this.db.select<Row>(SPECS.campaigns.table, {
        filters,
        order: [
          { col: 'created_at', ascending: false },
          { col: 'seq', ascending: true },
        ],
        limit: query.limit ?? 50,
        offset: query.offset ?? 0,
      }),
    ]);
    return { items: await this.hydrate(rows), total };
  }

  async deleteCampaign(id: string): Promise<boolean> {
    return Boolean(await this.db.rpc<boolean>('nk_delete_campaign', { p_id: id }));
  }

  async findDueCampaigns(nowIso: string): Promise<Campaign[]> {
    const rows = await selectAllBySeq<Row>(this.db, SPECS.campaigns.table, {
      filters: [
        eq('status', 'scheduled'),
        { col: 'scheduled_at', op: 'not.is', value: null },
        { col: 'scheduled_at', op: 'neq', value: '' },
        { col: 'scheduled_at', op: 'lte', value: nowIso },
      ],
    });
    return this.hydrate(rows);
  }

  async findSendingCampaigns(): Promise<Campaign[]> {
    const rows = await selectAllBySeq<Row>(this.db, SPECS.campaigns.table, { filters: [eq('status', 'sending')] });
    return this.hydrate(rows);
  }

  // ── deliveries ──────────────────────────────────────────
  /**
   * 寫入寄送紀錄。5,000 筆以內一次請求（同一個交易）；更多時分段寫入，
   * 中途失敗就刪掉這次已寫入的段落再丟錯，避免留下「只建了一半」的寄送清單
   * （寄送流程看到已有紀錄就會直接沿用）。
   */
  async createDeliveries(deliveries: Delivery[]): Promise<void> {
    if (deliveries.length === 0) return;
    const rows = deliveries.map((d) => toRow(SPECS.deliveries, d));
    const parts = chunk(rows, this.deliveryInsertChunk);
    const written: string[] = [];
    try {
      for (const part of parts) {
        await this.db.insert(SPECS.deliveries.table, part, { ignoreDuplicates: true });
        written.push(...part.map((r) => String(r.id)));
      }
    } catch (error) {
      if (written.length > 0) {
        try {
          for (const ids of chunkByLength(written)) {
            await this.db.delete(SPECS.deliveries.table, [{ col: 'id', op: 'in', value: ids }]);
          }
        } catch (cleanupError) {
          logger.error('寄送紀錄分段寫入失敗，且無法清掉已寫入的部分', {
            written: written.length,
            total: rows.length,
            error: (cleanupError as Error).message,
          });
        }
      }
      throw error;
    }
  }

  async updateDelivery(id: string, patch: Partial<Delivery>): Promise<void> {
    await this.updateDeliveries([{ id, patch }]);
  }

  async claimDeliveries(ids: string[], claim: DeliveryClaim): Promise<string[]> {
    if (ids.length === 0) return [];
    const claimed = await this.db.rpc<string[] | null>('nk_claim_deliveries', {
      p_ids: ids,
      p_claim_id: claim.claimId,
      p_claimed_at: claim.claimedAt,
    });
    return claimed ?? [];
  }

  /**
   * 一次寫回多筆寄送結果，回傳實際套用的筆數（找不到的紀錄不算）。
   * 同一筆在這批裡出現多次時依序合併，跟逐筆套用的結果相同。
   */
  async updateDeliveries(updates: DeliveryUpdate[]): Promise<number> {
    if (updates.length === 0) return 0;
    const merged = new Map<string, Row>();
    for (const { id, patch } of updates) {
      const { columns, extra } = patchToRow(SPECS.deliveries, patch);
      const current = merged.get(id) ?? {};
      const next: Row = { ...current, ...columns };
      if (extra) {
        const changes = Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, v === undefined ? null : v]));
        next.extra = { ...((current.extra as Row | undefined) ?? {}), ...changes };
      }
      merged.set(id, next);
    }
    const found = new Set<string>();
    for (const part of chunk([...merged.entries()], DELIVERY_UPDATE_CHUNK)) {
      const ids = await this.db.rpc<string[] | null>('nk_update_deliveries', {
        p_updates: part.map(([id, patch]) => ({ id, patch })),
      });
      for (const id of ids ?? []) found.add(id);
    }
    return updates.filter((u) => found.has(u.id)).length;
  }

  findDeliveryByProviderMessageId(providerMessageId: string): Promise<Delivery | null> {
    return this.findOne<Delivery>(SPECS.deliveries, [eq('provider_message_id', providerMessageId)]);
  }

  listDeliveries(
    campaignId: string,
    options: { status?: DeliveryStatus | undefined; limit?: number | undefined } = {},
  ): Promise<Delivery[]> {
    const filters: Filter[] = [eq('campaign_id', campaignId)];
    if (options.status) filters.push(eq('status', options.status));
    return this.findAll<Delivery>(SPECS.deliveries, filters, options.limit || undefined);
  }

  async deliveryStats(campaignId: string): Promise<CampaignStats> {
    return deliveryStatsOf((await this.statsFor([campaignId])).get(campaignId) ?? ZERO_STATS);
  }

  async deleteDeliveries(campaignId: string): Promise<void> {
    await this.db.delete(SPECS.deliveries.table, [eq('campaign_id', campaignId)]);
  }

  // ── tracking ────────────────────────────────────────────
  async createEvent(event: TrackingEvent): Promise<void> {
    await this.db.insert(SPECS.events.table, [toRow(SPECS.events, event)], { ignoreDuplicates: true });
  }

  listTrackingEvents(
    query: { campaignId?: string; type?: 'open' | 'click'; since?: string } = {},
  ): Promise<TrackingEvent[]> {
    const filters: Filter[] = [];
    if (query.campaignId) filters.push(eq('campaign_id', query.campaignId));
    if (query.type) filters.push(eq('type', query.type));
    if (query.since) filters.push({ col: 'created_at', op: 'gte', value: query.since });
    return this.findAll<TrackingEvent>(SPECS.events, filters);
  }

  async campaignTrackingStats(campaignId: string): Promise<TrackingStats> {
    return trackingOf((await this.statsFor([campaignId])).get(campaignId) ?? ZERO_STATS);
  }

  async periodStats(query: PeriodQuery = {}): Promise<PeriodStats> {
    const stats = await this.db.rpc<Record<string, unknown>>('nk_period_stats', {
      p_from: query.from || null,
      p_to: query.to || null,
    });
    const n = (key: string) => Number(stats?.[key] ?? 0);
    return {
      newSubscribers: n('newSubscribers'),
      unsubscribes: n('unsubscribes'),
      sentCampaigns: n('sentCampaigns'),
      sent: n('sent'),
      uniqueOpens: n('uniqueOpens'),
      uniqueClicks: n('uniqueClicks'),
      orphanEvents: n('orphanEvents'),
    };
  }

  // ── sequences ───────────────────────────────────────────
  async createSequence(sequence: Sequence): Promise<Sequence> {
    await this.insertOne(SPECS.sequences, sequence);
    return structuredClone(sequence);
  }

  updateSequence(id: string, patch: Partial<Sequence>): Promise<Sequence | null> {
    return this.patchRow<Sequence>(SPECS.sequences, id, patch);
  }

  getSequence(id: string): Promise<Sequence | null> {
    return this.findOne<Sequence>(SPECS.sequences, [eq('id', id)]);
  }

  async listSequences(): Promise<Sequence[]> {
    return (await this.findAll<Sequence>(SPECS.sequences)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async deleteSequence(id: string): Promise<boolean> {
    return Boolean(await this.db.rpc<boolean>('nk_delete_sequence', { p_id: id }));
  }

  async replaceSequenceSteps(sequenceId: string, steps: SequenceStep[]): Promise<SequenceStep[]> {
    await this.db.rpc('nk_replace_sequence_steps', {
      p_sequence_id: sequenceId,
      p_steps: steps.map((step) => toRow(SPECS.sequenceSteps, step)),
    });
    return steps.map((step) => structuredClone(step));
  }

  async listSequenceSteps(sequenceId: string): Promise<SequenceStep[]> {
    return (await this.findAll<SequenceStep>(SPECS.sequenceSteps, [eq('sequence_id', sequenceId)])).sort(
      (a, b) => a.position - b.position,
    );
  }

  /** 同一人同一序列只會有一筆；另一個實例剛好先建立時回傳既有那筆，不重複報名。 */
  async createEnrollment(enrollment: SequenceEnrollment): Promise<SequenceEnrollment> {
    try {
      await this.insertOne(SPECS.enrollments, enrollment);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.getEnrollment(enrollment.sequenceId, enrollment.subscriberId);
      if (existing) return existing;
      throw error;
    }
    return structuredClone(enrollment);
  }

  updateEnrollment(id: string, patch: Partial<SequenceEnrollment>): Promise<SequenceEnrollment | null> {
    return this.patchRow<SequenceEnrollment>(SPECS.enrollments, id, patch);
  }

  getEnrollment(sequenceId: string, subscriberId: string): Promise<SequenceEnrollment | null> {
    return this.findOne<SequenceEnrollment>(SPECS.enrollments, [
      eq('sequence_id', sequenceId),
      eq('subscriber_id', subscriberId),
    ]);
  }

  async listEnrollments(sequenceId: string): Promise<SequenceEnrollment[]> {
    return (await this.findAll<SequenceEnrollment>(SPECS.enrollments, [eq('sequence_id', sequenceId)])).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }

  findDueEnrollments(nowIso: string): Promise<SequenceEnrollment[]> {
    return this.findAll<SequenceEnrollment>(SPECS.enrollments, [
      eq('status', 'active'),
      { col: 'next_run_at', op: 'lte', value: nowIso },
    ]);
  }

  // ── templates ───────────────────────────────────────────
  private async templateNameTaken(name: string, exceptId?: string): Promise<boolean> {
    const target = name.trim().toLowerCase();
    return (await this.findAll<ContentTemplate>(SPECS.templates)).some(
      (t) => t.name.toLowerCase() === target && t.id !== exceptId,
    );
  }

  async createTemplate(template: ContentTemplate): Promise<ContentTemplate> {
    if (await this.templateNameTaken(template.name)) throw conflict('這個範本名稱已被使用');
    await this.insertOne(SPECS.templates, template);
    return structuredClone(template);
  }

  async updateTemplate(id: string, patch: Partial<ContentTemplate>): Promise<ContentTemplate | null> {
    if (!(await this.getTemplate(id))) return null;
    if (patch.name && (await this.templateNameTaken(patch.name, id))) throw conflict('這個範本名稱已被使用');
    return this.patchRow<ContentTemplate>(SPECS.templates, id, patch);
  }

  getTemplate(id: string): Promise<ContentTemplate | null> {
    return this.findOne<ContentTemplate>(SPECS.templates, [eq('id', id)]);
  }

  async listTemplates(): Promise<ContentTemplate[]> {
    return (await this.findAll<ContentTemplate>(SPECS.templates)).sort(byName);
  }

  async deleteTemplate(id: string): Promise<boolean> {
    return (await this.db.delete(SPECS.templates.table, [eq('id', id)])) > 0;
  }

  // ── settings ────────────────────────────────────────────
  async getSetting(key: string): Promise<string | undefined> {
    const rows = await this.db.select<{ value: string }>(SETTINGS_TABLE, {
      filters: [eq('key', key)],
      columns: 'value',
      limit: 1,
    });
    return rows[0]?.value ?? undefined;
  }

  async getSettings(keys: string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const part of chunkByLength([...new Set(keys)])) {
      const rows = await this.db.select<{ key: string; value: string }>(SETTINGS_TABLE, {
        filters: [{ col: 'key', op: 'in', value: part }],
        columns: 'key,value',
      });
      for (const row of rows) out[row.key] = row.value;
    }
    return out;
  }

  async setSetting(key: string, value: string): Promise<void> {
    await this.db.upsert(SETTINGS_TABLE, [{ key, value }], { onConflict: 'key' });
  }

  // ── campaign starters ───────────────────────────────────
  private async starterNameTaken(name: string, exceptId?: string): Promise<boolean> {
    const target = name.trim().toLowerCase();
    return (await this.findAll<CampaignStarter>(SPECS.campaignStarters)).some(
      (t) => t.name.toLowerCase() === target && t.id !== exceptId,
    );
  }

  async createCampaignStarter(starter: CampaignStarter): Promise<CampaignStarter> {
    if (await this.starterNameTaken(starter.name)) throw conflict('這個模板名稱已被使用');
    await this.insertOne(SPECS.campaignStarters, starter);
    return structuredClone(starter);
  }

  async updateCampaignStarter(id: string, patch: Partial<CampaignStarter>): Promise<CampaignStarter | null> {
    if (!(await this.getCampaignStarter(id))) return null;
    if (patch.name && (await this.starterNameTaken(patch.name, id))) throw conflict('這個模板名稱已被使用');
    return this.patchRow<CampaignStarter>(SPECS.campaignStarters, id, patch);
  }

  getCampaignStarter(id: string): Promise<CampaignStarter | null> {
    return this.findOne<CampaignStarter>(SPECS.campaignStarters, [eq('id', id)]);
  }

  async listCampaignStarters(): Promise<CampaignStarter[]> {
    return (await this.findAll<CampaignStarter>(SPECS.campaignStarters)).sort(byName);
  }

  async deleteCampaignStarter(id: string): Promise<boolean> {
    return (await this.db.delete(SPECS.campaignStarters.table, [eq('id', id)])) > 0;
  }
}

/** 重試撞到唯一鍵時，確認既有那列就是這次要寫的內容（逐欄比對寫入值）。 */
function sameWrite(written: Row, existing: Row): boolean {
  for (const [column, value] of Object.entries(written)) {
    if (!isDeepStrictEqual(existing[column] ?? null, value ?? null)) return false;
  }
  return true;
}

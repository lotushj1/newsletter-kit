import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { conflict } from '../core/errors.js';
import type {
  Campaign,
  CampaignQuery,
  CampaignStats,
  Delivery,
  DeliveryStatus,
  Paged,
  Store,
  Subscriber,
  SubscriberQuery,
  SubscriberStatus,
} from './types.js';

interface SubscriberRow {
  id: string;
  email: string;
  name: string | null;
  status: string;
  tags: string;
  source: string | null;
  created_at: string;
  confirmed_at: string | null;
  unsubscribed_at: string | null;
  meta: string | null;
}

interface CampaignRow {
  id: string;
  title: string;
  slug: string;
  subject: string;
  preheader: string | null;
  body_markdown: string;
  status: string;
  audience_tags: string;
  scheduled_at: string | null;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
}

interface DeliveryRow {
  id: string;
  campaign_id: string;
  subscriber_id: string;
  email: string;
  status: string;
  attempts: number;
  error: string | null;
  provider_message_id: string | null;
  sent_at: string | null;
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS subscribers (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  status TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  source TEXT,
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  unsubscribed_at TEXT,
  meta TEXT
);
CREATE INDEX IF NOT EXISTS idx_subscribers_status ON subscribers(status);

CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  subject TEXT NOT NULL,
  preheader TEXT,
  body_markdown TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  audience_tags TEXT NOT NULL DEFAULT '[]',
  scheduled_at TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status, scheduled_at);

CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  subscriber_id TEXT NOT NULL,
  email TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  provider_message_id TEXT,
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_deliveries_campaign ON deliveries(campaign_id, status);
`;

const parseJson = <T>(raw: string | null, fallback: T): T => {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

function toSubscriber(row: SubscriberRow): Subscriber {
  return {
    id: row.id,
    email: row.email,
    name: row.name ?? undefined,
    status: row.status as SubscriberStatus,
    tags: parseJson<string[]>(row.tags, []),
    source: row.source ?? undefined,
    createdAt: row.created_at,
    confirmedAt: row.confirmed_at ?? undefined,
    unsubscribedAt: row.unsubscribed_at ?? undefined,
    meta: parseJson<Record<string, unknown> | undefined>(row.meta, undefined),
  };
}

function toCampaign(row: CampaignRow, stats: CampaignStats): Campaign {
  return {
    id: row.id,
    title: row.title,
    slug: row.slug,
    subject: row.subject,
    preheader: row.preheader ?? undefined,
    bodyMarkdown: row.body_markdown,
    status: row.status as Campaign['status'],
    audienceTags: parseJson<string[]>(row.audience_tags, []),
    scheduledAt: row.scheduled_at,
    sentAt: row.sent_at,
    stats,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toDelivery(row: DeliveryRow): Delivery {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    subscriberId: row.subscriber_id,
    email: row.email,
    status: row.status as DeliveryStatus,
    attempts: row.attempts,
    error: row.error ?? undefined,
    providerMessageId: row.provider_message_id ?? undefined,
    sentAt: row.sent_at ?? undefined,
  };
}

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Error && error.message.includes('UNIQUE constraint failed');

/** 預設 driver。單檔 SQLite，掛持久磁碟就能上線。 */
export class SqliteStore implements Store {
  readonly driver = 'sqlite';

  private db!: Database.Database;
  private readonly path: string;

  constructor(path: string) {
    this.path = resolve(process.cwd(), path);
  }

  async init(): Promise<void> {
    mkdirSync(dirname(this.path), { recursive: true });
    this.db = new Database(this.path);
    this.db.exec(SCHEMA);
  }

  async close(): Promise<void> {
    this.db?.close();
  }

  // ── subscribers ─────────────────────────────────────────
  async createSubscriber(subscriber: Subscriber): Promise<Subscriber> {
    try {
      this.db
        .prepare(
          `INSERT INTO subscribers (id, email, name, status, tags, source, created_at, confirmed_at, unsubscribed_at, meta)
           VALUES (@id, @email, @name, @status, @tags, @source, @created_at, @confirmed_at, @unsubscribed_at, @meta)`,
        )
        .run({
          id: subscriber.id,
          email: subscriber.email.toLowerCase(),
          name: subscriber.name ?? null,
          status: subscriber.status,
          tags: JSON.stringify(subscriber.tags),
          source: subscriber.source ?? null,
          created_at: subscriber.createdAt,
          confirmed_at: subscriber.confirmedAt ?? null,
          unsubscribed_at: subscriber.unsubscribedAt ?? null,
          meta: subscriber.meta ? JSON.stringify(subscriber.meta) : null,
        });
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('這個 Email 已在名單內');
      throw error;
    }
    return subscriber;
  }

  async updateSubscriber(id: string, patch: Partial<Subscriber>): Promise<Subscriber | null> {
    const current = await this.getSubscriber(id);
    if (!current) return null;
    const next: Subscriber = { ...current, ...patch, id };
    this.db
      .prepare(
        `UPDATE subscribers SET email=@email, name=@name, status=@status, tags=@tags, source=@source,
         confirmed_at=@confirmed_at, unsubscribed_at=@unsubscribed_at, meta=@meta WHERE id=@id`,
      )
      .run({
        id,
        email: next.email.toLowerCase(),
        name: next.name ?? null,
        status: next.status,
        tags: JSON.stringify(next.tags),
        source: next.source ?? null,
        confirmed_at: next.confirmedAt ?? null,
        unsubscribed_at: next.unsubscribedAt ?? null,
        meta: next.meta ? JSON.stringify(next.meta) : null,
      });
    return next;
  }

  async getSubscriber(id: string): Promise<Subscriber | null> {
    const row = this.db.prepare('SELECT * FROM subscribers WHERE id = ?').get(id) as
      | SubscriberRow
      | undefined;
    return row ? toSubscriber(row) : null;
  }

  async getSubscriberByEmail(email: string): Promise<Subscriber | null> {
    const row = this.db
      .prepare('SELECT * FROM subscribers WHERE email = ?')
      .get(email.toLowerCase()) as SubscriberRow | undefined;
    return row ? toSubscriber(row) : null;
  }

  async listSubscribers(query: SubscriberQuery = {}): Promise<Paged<Subscriber>> {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (query.status) {
      where.push('status = @status');
      params.status = query.status;
    }
    if (query.search) {
      where.push('(email LIKE @search OR IFNULL(name, \'\') LIKE @search)');
      params.search = `%${query.search.toLowerCase()}%`;
    }
    if (query.tag) {
      // tags 存 JSON 陣列，用 LIKE 找 "tag" 字串即可滿足單標籤篩選。
      where.push('tags LIKE @tag');
      params.tag = `%"${query.tag.toLowerCase()}"%`;
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM subscribers ${clause}`).get(params) as {
        n: number;
      }
    ).n;
    const rows = this.db
      .prepare(
        `SELECT * FROM subscribers ${clause} ORDER BY created_at DESC LIMIT @limit OFFSET @offset`,
      )
      .all({ ...params, limit: query.limit ?? 50, offset: query.offset ?? 0 }) as SubscriberRow[];
    return { items: rows.map(toSubscriber), total };
  }

  async deleteSubscriber(id: string): Promise<boolean> {
    return this.db.prepare('DELETE FROM subscribers WHERE id = ?').run(id).changes > 0;
  }

  async countSubscribersByStatus(): Promise<Record<SubscriberStatus, number>> {
    const counts: Record<SubscriberStatus, number> = {
      pending: 0,
      subscribed: 0,
      unsubscribed: 0,
      bounced: 0,
    };
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS n FROM subscribers GROUP BY status')
      .all() as { status: SubscriberStatus; n: number }[];
    for (const row of rows) {
      if (row.status in counts) counts[row.status] = row.n;
    }
    return counts;
  }

  async listAudience(tags: string[]): Promise<Subscriber[]> {
    const rows = this.db
      .prepare("SELECT * FROM subscribers WHERE status = 'subscribed' ORDER BY created_at ASC")
      .all() as SubscriberRow[];
    const wanted = tags.map((t) => t.toLowerCase());
    return rows
      .map(toSubscriber)
      .filter((s) => (wanted.length === 0 ? true : s.tags.some((t) => wanted.includes(t))));
  }

  // ── campaigns ───────────────────────────────────────────
  async createCampaign(campaign: Campaign): Promise<Campaign> {
    try {
      this.db
        .prepare(
          `INSERT INTO campaigns (id, title, slug, subject, preheader, body_markdown, status, audience_tags, scheduled_at, sent_at, created_at, updated_at)
           VALUES (@id, @title, @slug, @subject, @preheader, @body_markdown, @status, @audience_tags, @scheduled_at, @sent_at, @created_at, @updated_at)`,
        )
        .run({
          id: campaign.id,
          title: campaign.title,
          slug: campaign.slug,
          subject: campaign.subject,
          preheader: campaign.preheader ?? null,
          body_markdown: campaign.bodyMarkdown,
          status: campaign.status,
          audience_tags: JSON.stringify(campaign.audienceTags),
          scheduled_at: campaign.scheduledAt ?? null,
          sent_at: campaign.sentAt ?? null,
          created_at: campaign.createdAt,
          updated_at: campaign.updatedAt,
        });
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('這個 slug 已被使用');
      throw error;
    }
    return campaign;
  }

  async updateCampaign(id: string, patch: Partial<Campaign>): Promise<Campaign | null> {
    const current = await this.getCampaign(id);
    if (!current) return null;
    const next: Campaign = { ...current, ...patch, id };
    try {
      this.db
        .prepare(
          `UPDATE campaigns SET title=@title, slug=@slug, subject=@subject, preheader=@preheader,
           body_markdown=@body_markdown, status=@status, audience_tags=@audience_tags,
           scheduled_at=@scheduled_at, sent_at=@sent_at, updated_at=@updated_at WHERE id=@id`,
        )
        .run({
          id,
          title: next.title,
          slug: next.slug,
          subject: next.subject,
          preheader: next.preheader ?? null,
          body_markdown: next.bodyMarkdown,
          status: next.status,
          audience_tags: JSON.stringify(next.audienceTags),
          scheduled_at: next.scheduledAt ?? null,
          sent_at: next.sentAt ?? null,
          updated_at: next.updatedAt,
        });
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('這個 slug 已被使用');
      throw error;
    }
    return next;
  }

  async getCampaign(id: string): Promise<Campaign | null> {
    const row = this.db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id) as
      | CampaignRow
      | undefined;
    return row ? toCampaign(row, await this.deliveryStats(row.id)) : null;
  }

  async getCampaignBySlug(slug: string): Promise<Campaign | null> {
    const row = this.db.prepare('SELECT * FROM campaigns WHERE slug = ?').get(slug) as
      | CampaignRow
      | undefined;
    return row ? toCampaign(row, await this.deliveryStats(row.id)) : null;
  }

  async listCampaigns(query: CampaignQuery = {}): Promise<Paged<Campaign>> {
    const clause = query.status ? 'WHERE status = @status' : '';
    const params = query.status ? { status: query.status } : {};
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM campaigns ${clause}`).get(params) as { n: number }
    ).n;
    const rows = this.db
      .prepare(
        `SELECT * FROM campaigns ${clause} ORDER BY created_at DESC LIMIT @limit OFFSET @offset`,
      )
      .all({ ...params, limit: query.limit ?? 50, offset: query.offset ?? 0 }) as CampaignRow[];
    const items = await Promise.all(rows.map(async (r) => toCampaign(r, await this.deliveryStats(r.id))));
    return { items, total };
  }

  async deleteCampaign(id: string): Promise<boolean> {
    await this.deleteDeliveries(id);
    return this.db.prepare('DELETE FROM campaigns WHERE id = ?').run(id).changes > 0;
  }

  async findDueCampaigns(nowIso: string): Promise<Campaign[]> {
    const rows = this.db
      .prepare(
        "SELECT * FROM campaigns WHERE status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= ?",
      )
      .all(nowIso) as CampaignRow[];
    return Promise.all(rows.map(async (r) => toCampaign(r, await this.deliveryStats(r.id))));
  }

  async findSendingCampaigns(): Promise<Campaign[]> {
    const rows = this.db
      .prepare("SELECT * FROM campaigns WHERE status = 'sending'")
      .all() as CampaignRow[];
    return Promise.all(rows.map(async (r) => toCampaign(r, await this.deliveryStats(r.id))));
  }

  // ── deliveries ──────────────────────────────────────────
  async createDeliveries(deliveries: Delivery[]): Promise<void> {
    const insert = this.db.prepare(
      `INSERT INTO deliveries (id, campaign_id, subscriber_id, email, status, attempts, error, provider_message_id, sent_at)
       VALUES (@id, @campaign_id, @subscriber_id, @email, @status, @attempts, @error, @provider_message_id, @sent_at)`,
    );
    const insertMany = this.db.transaction((items: Delivery[]) => {
      for (const item of items) {
        insert.run({
          id: item.id,
          campaign_id: item.campaignId,
          subscriber_id: item.subscriberId,
          email: item.email,
          status: item.status,
          attempts: item.attempts,
          error: item.error ?? null,
          provider_message_id: item.providerMessageId ?? null,
          sent_at: item.sentAt ?? null,
        });
      }
    });
    insertMany(deliveries);
  }

  async updateDelivery(id: string, patch: Partial<Delivery>): Promise<void> {
    const row = this.db.prepare('SELECT * FROM deliveries WHERE id = ?').get(id) as
      | DeliveryRow
      | undefined;
    if (!row) return;
    const next: Delivery = { ...toDelivery(row), ...patch, id };
    this.db
      .prepare(
        `UPDATE deliveries SET status=@status, attempts=@attempts, error=@error,
         provider_message_id=@provider_message_id, sent_at=@sent_at WHERE id=@id`,
      )
      .run({
        id,
        status: next.status,
        attempts: next.attempts,
        error: next.error ?? null,
        provider_message_id: next.providerMessageId ?? null,
        sent_at: next.sentAt ?? null,
      });
  }

  async listDeliveries(
    campaignId: string,
    options: { status?: DeliveryStatus | undefined; limit?: number | undefined } = {},
  ): Promise<Delivery[]> {
    const clause = options.status ? 'AND status = @status' : '';
    const rows = this.db
      .prepare(
        `SELECT * FROM deliveries WHERE campaign_id = @campaignId ${clause} ORDER BY rowid ASC LIMIT @limit`,
      )
      .all({
        campaignId,
        status: options.status ?? null,
        limit: options.limit ?? 1000,
      }) as DeliveryRow[];
    return rows.map(toDelivery);
  }

  async deliveryStats(campaignId: string): Promise<CampaignStats> {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
         FROM deliveries WHERE campaign_id = ?`,
      )
      .get(campaignId) as { total: number; sent: number | null; failed: number | null };
    return { total: row.total, sent: row.sent ?? 0, failed: row.failed ?? 0 };
  }

  async deleteDeliveries(campaignId: string): Promise<void> {
    this.db.prepare('DELETE FROM deliveries WHERE campaign_id = ?').run(campaignId);
  }
}

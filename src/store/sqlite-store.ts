import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { conflict } from '../core/errors.js';
import type {
  AudienceQuery,
  Campaign,
  CampaignStarter,
  CampaignQuery,
  CampaignStats,
  Delivery,
  DeliveryStatus,
  Folder,
  FolderKind,
  PeriodQuery,
  PeriodStats,
  Paged,
  ContentTemplate,
  Sequence,
  SequenceEnrollment,
  SequenceEnrollmentStatus,
  SequenceStep,
  SequenceTrigger,
  Store,
  Subscriber,
  SubscriberQuery,
  SubscriberStatus,
  TrackingEvent,
  TrackingStats,
} from './types.js';
import { EMPTY_TRACKING } from './types.js';

interface SubscriberRow {
  id: string;
  email: string;
  name: string | null;
  status: string;
  tags: string;
  folder_id: string | null;
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
  body_html: string | null;
  status: string;
  audience_tags: string;
  audience_folder_id: string | null;
  folder_id: string | null;
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

interface EventRow {
  id: string;
  campaign_id: string;
  subscriber_id: string | null;
  delivery_id: string | null;
  type: string;
  url: string | null;
  created_at: string;
}

interface SequenceRow {
  id: string;
  name: string;
  trigger: string;
  trigger_value: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

interface SequenceStepRow {
  id: string;
  sequence_id: string;
  position: number;
  delay_days: number;
  campaign_id: string;
}

interface FolderRow {
  id: string;
  name: string;
  kind: string | null;
  created_at: string;
}

interface TemplateRow {
  id: string;
  name: string;
  html: string;
  created_at: string;
  updated_at: string;
}

interface StarterRow {
  id: string;
  name: string;
  description: string;
  title: string;
  preheader: string;
  body_html: string;
  created_at: string;
  updated_at: string;
}

interface EnrollmentRow {
  id: string;
  sequence_id: string;
  subscriber_id: string;
  step_index: number;
  next_run_at: string;
  status: string;
  created_at: string;
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
  folder_id TEXT,
  source TEXT,
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  unsubscribed_at TEXT,
  meta TEXT
);
CREATE INDEX IF NOT EXISTS idx_subscribers_status ON subscribers(status);

CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'subscribers',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  subject TEXT NOT NULL,
  preheader TEXT,
  body_markdown TEXT NOT NULL DEFAULT '',
  body_html TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  audience_tags TEXT NOT NULL DEFAULT '[]',
  audience_folder_id TEXT,
  folder_id TEXT,
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

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  subscriber_id TEXT,
  delivery_id TEXT,
  type TEXT NOT NULL,
  url TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_campaign ON events(campaign_id, type);

CREATE TABLE IF NOT EXISTS sequences (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  trigger TEXT NOT NULL,
  trigger_value TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sequence_steps (
  id TEXT PRIMARY KEY,
  sequence_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  delay_days INTEGER NOT NULL DEFAULT 0,
  campaign_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sequence_steps ON sequence_steps(sequence_id, position);

CREATE TABLE IF NOT EXISTS sequence_enrollments (
  id TEXT PRIMARY KEY,
  sequence_id TEXT NOT NULL,
  subscriber_id TEXT NOT NULL,
  step_index INTEGER NOT NULL DEFAULT 0,
  next_run_at TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (sequence_id, subscriber_id)
);
CREATE INDEX IF NOT EXISTS idx_enrollments_due ON sequence_enrollments(status, next_run_at);

CREATE TABLE IF NOT EXISTS content_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  html TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campaign_starters (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  preheader TEXT NOT NULL DEFAULT '',
  body_html TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
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
    folderId: row.folder_id ?? undefined,
    source: row.source ?? undefined,
    createdAt: row.created_at,
    confirmedAt: row.confirmed_at ?? undefined,
    unsubscribedAt: row.unsubscribed_at ?? undefined,
    meta: parseJson<Record<string, unknown> | undefined>(row.meta, undefined),
  };
}

function toCampaign(row: CampaignRow, stats: CampaignStats, tracking: TrackingStats): Campaign {
  return {
    id: row.id,
    title: row.title,
    slug: row.slug,
    subject: row.subject,
    preheader: row.preheader ?? undefined,
    bodyMarkdown: row.body_markdown,
    bodyHtml: row.body_html ?? '',
    status: row.status as Campaign['status'],
    audienceTags: parseJson<string[]>(row.audience_tags, []),
    audienceFolderId: row.audience_folder_id ?? undefined,
    folderId: row.folder_id ?? undefined,
    scheduledAt: row.scheduled_at,
    sentAt: row.sent_at,
    stats,
    tracking,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toFolder(row: FolderRow): Folder {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind === 'campaigns' ? 'campaigns' : 'subscribers',
    createdAt: row.created_at,
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

function toSequence(row: SequenceRow): Sequence {
  return {
    id: row.id,
    name: row.name,
    trigger: row.trigger as SequenceTrigger,
    triggerValue: row.trigger_value ?? undefined,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toStep(row: SequenceStepRow): SequenceStep {
  return {
    id: row.id,
    sequenceId: row.sequence_id,
    position: row.position,
    delayDays: row.delay_days,
    campaignId: row.campaign_id,
  };
}

function toTemplate(row: TemplateRow): ContentTemplate {
  return {
    id: row.id,
    name: row.name,
    html: row.html,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toStarter(row: StarterRow): CampaignStarter {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    title: row.title,
    preheader: row.preheader,
    bodyHtml: row.body_html,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toEnrollment(row: EnrollmentRow): SequenceEnrollment {
  return {
    id: row.id,
    sequenceId: row.sequence_id,
    subscriberId: row.subscriber_id,
    stepIndex: row.step_index,
    nextRunAt: row.next_run_at,
    status: row.status as SequenceEnrollmentStatus,
    createdAt: row.created_at,
  };
}

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Error && error.message.includes('UNIQUE constraint failed');

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === column);
}

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
    if (!hasColumn(this.db, 'campaigns', 'body_html')) {
      this.db.exec(`ALTER TABLE campaigns ADD COLUMN body_html TEXT NOT NULL DEFAULT ''`);
    }
    if (!hasColumn(this.db, 'subscribers', 'folder_id')) {
      this.db.exec(`ALTER TABLE subscribers ADD COLUMN folder_id TEXT`);
    }
    if (!hasColumn(this.db, 'campaigns', 'audience_folder_id')) {
      this.db.exec(`ALTER TABLE campaigns ADD COLUMN audience_folder_id TEXT`);
    }
    if (!hasColumn(this.db, 'folders', 'kind')) {
      this.db.exec(`ALTER TABLE folders ADD COLUMN kind TEXT NOT NULL DEFAULT 'subscribers'`);
    }
    if (!hasColumn(this.db, 'campaigns', 'folder_id')) {
      this.db.exec(`ALTER TABLE campaigns ADD COLUMN folder_id TEXT`);
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_subscribers_folder ON subscribers(folder_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_campaigns_folder ON campaigns(folder_id)`);
  }

  async close(): Promise<void> {
    this.db?.close();
  }

  private async hydrate(row: CampaignRow): Promise<Campaign> {
    return toCampaign(row, await this.deliveryStats(row.id), await this.campaignTrackingStats(row.id));
  }

  // ── subscribers ─────────────────────────────────────────
  async createSubscriber(subscriber: Subscriber): Promise<Subscriber> {
    try {
      this.db
        .prepare(
          `INSERT INTO subscribers (id, email, name, status, tags, folder_id, source, created_at, confirmed_at, unsubscribed_at, meta)
           VALUES (@id, @email, @name, @status, @tags, @folder_id, @source, @created_at, @confirmed_at, @unsubscribed_at, @meta)`,
        )
        .run({
          id: subscriber.id,
          email: subscriber.email.toLowerCase(),
          name: subscriber.name ?? null,
          status: subscriber.status,
          tags: JSON.stringify(subscriber.tags),
          folder_id: subscriber.folderId ?? null,
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
        `UPDATE subscribers SET email=@email, name=@name, status=@status, tags=@tags, folder_id=@folder_id, source=@source,
         confirmed_at=@confirmed_at, unsubscribed_at=@unsubscribed_at, meta=@meta WHERE id=@id`,
      )
      .run({
        id,
        email: next.email.toLowerCase(),
        name: next.name ?? null,
        status: next.status,
        tags: JSON.stringify(next.tags),
        folder_id: next.folderId ?? null,
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
      where.push("(email LIKE @search OR IFNULL(name, '') LIKE @search)");
      params.search = `%${query.search.toLowerCase()}%`;
    }
    if (query.tag) {
      where.push('tags LIKE @tag');
      params.tag = `%"${query.tag.toLowerCase()}"%`;
    }
    if (query.folderId === 'unfiled') {
      where.push("(folder_id IS NULL OR folder_id = '')");
    } else if (query.folderId) {
      where.push('folder_id = @folder_id');
      params.folder_id = query.folderId;
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

  async listSubscriberTags(): Promise<string[]> {
    const rows = this.db.prepare('SELECT tags FROM subscribers').all() as { tags: string }[];
    const tags = new Set<string>();
    for (const row of rows) {
      for (const tag of parseJson<string[]>(row.tags, [])) tags.add(tag);
    }
    return [...tags].sort();
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

  async countSubscribersByFolder(): Promise<Record<string, number>> {
    const counts: Record<string, number> = { '': 0 };
    const rows = this.db
      .prepare(`SELECT IFNULL(folder_id, '') AS folder_id, COUNT(*) AS n FROM subscribers GROUP BY folder_id`)
      .all() as { folder_id: string; n: number }[];
    for (const row of rows) counts[row.folder_id] = row.n;
    return counts;
  }

  async listAudience(query: AudienceQuery = {}): Promise<Subscriber[]> {
    const rows = this.db
      .prepare("SELECT * FROM subscribers WHERE status = 'subscribed' ORDER BY created_at ASC")
      .all() as SubscriberRow[];
    const wanted = (query.tags ?? []).map((t) => t.toLowerCase());
    return rows
      .map(toSubscriber)
      .filter((s) => {
        if (query.folderId === 'unfiled') return !s.folderId;
        if (query.folderId) return s.folderId === query.folderId;
        return true;
      })
      .filter((s) => (wanted.length === 0 ? true : s.tags.some((t) => wanted.includes(t))));
  }

  async createFolder(folder: Folder): Promise<Folder> {
    const kind = folder.kind ?? 'subscribers';
    if (this.findFolderByName(folder.name, undefined, kind)) throw conflict('這個資料夾名稱已被使用');
    this.db
      .prepare('INSERT INTO folders (id, name, kind, created_at) VALUES (@id, @name, @kind, @created_at)')
      .run({ id: folder.id, name: folder.name, kind, created_at: folder.createdAt });
    return { ...folder, kind };
  }

  async updateFolder(id: string, patch: Partial<Folder>): Promise<Folder | null> {
    const current = await this.getFolder(id);
    if (!current) return null;
    if (patch.name && this.findFolderByName(patch.name, id, current.kind)) throw conflict('這個資料夾名稱已被使用');
    const next: Folder = { ...current, ...patch, id, kind: current.kind };
    this.db.prepare('UPDATE folders SET name=@name WHERE id=@id').run({ id, name: next.name });
    return next;
  }

  async getFolder(id: string): Promise<Folder | null> {
    const row = this.db.prepare('SELECT * FROM folders WHERE id = ?').get(id) as FolderRow | undefined;
    return row ? toFolder(row) : null;
  }

  async listFolders(kind: FolderKind = 'subscribers'): Promise<Folder[]> {
    const rows = this.db
      .prepare(`SELECT * FROM folders WHERE IFNULL(kind, 'subscribers') = ? ORDER BY name COLLATE NOCASE`)
      .all(kind) as FolderRow[];
    return rows.map(toFolder);
  }

  async deleteFolder(id: string): Promise<boolean> {
    const found = await this.getFolder(id);
    if (!found) return false;
    if (found.kind === 'campaigns') {
      this.db.prepare(`UPDATE campaigns SET folder_id = NULL WHERE folder_id = ?`).run(id);
    } else {
      this.db.prepare(`UPDATE subscribers SET folder_id = NULL WHERE folder_id = ?`).run(id);
      this.db.prepare(`UPDATE campaigns SET audience_folder_id = NULL WHERE audience_folder_id = ?`).run(id);
    }
    this.db.prepare('DELETE FROM folders WHERE id = ?').run(id);
    return true;
  }

  async countCampaignsByFolder(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    const rows = this.db
      .prepare(`SELECT IFNULL(folder_id, '') AS folder_id, COUNT(*) AS n FROM campaigns GROUP BY folder_id`)
      .all() as { folder_id: string; n: number }[];
    for (const row of rows) counts[row.folder_id] = row.n;
    return counts;
  }

  private findFolderByName(name: string, exceptId?: string, kind: FolderKind = 'subscribers'): Folder | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM folders WHERE lower(name) = lower(?) AND id != ? AND IFNULL(kind, 'subscribers') = ?`,
      )
      .get(name.trim(), exceptId ?? '', kind) as FolderRow | undefined;
    return row ? toFolder(row) : undefined;
  }

  // ── campaigns ───────────────────────────────────────────
  async createCampaign(campaign: Campaign): Promise<Campaign> {
    try {
      this.db
        .prepare(
          `INSERT INTO campaigns (id, title, slug, subject, preheader, body_markdown, body_html, status, audience_tags, audience_folder_id, folder_id, scheduled_at, sent_at, created_at, updated_at)
           VALUES (@id, @title, @slug, @subject, @preheader, @body_markdown, @body_html, @status, @audience_tags, @audience_folder_id, @folder_id, @scheduled_at, @sent_at, @created_at, @updated_at)`,
        )
        .run({
          id: campaign.id,
          title: campaign.title,
          slug: campaign.slug,
          subject: campaign.subject,
          preheader: campaign.preheader ?? null,
          body_markdown: campaign.bodyMarkdown,
          body_html: campaign.bodyHtml ?? '',
          status: campaign.status,
          audience_tags: JSON.stringify(campaign.audienceTags),
          audience_folder_id: campaign.audienceFolderId ?? null,
          folder_id: campaign.folderId ?? null,
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
           body_markdown=@body_markdown, body_html=@body_html, status=@status, audience_tags=@audience_tags,
           audience_folder_id=@audience_folder_id, folder_id=@folder_id, scheduled_at=@scheduled_at, sent_at=@sent_at, updated_at=@updated_at WHERE id=@id`,
        )
        .run({
          id,
          title: next.title,
          slug: next.slug,
          subject: next.subject,
          preheader: next.preheader ?? null,
          body_markdown: next.bodyMarkdown,
          body_html: next.bodyHtml ?? '',
          status: next.status,
          audience_tags: JSON.stringify(next.audienceTags),
          audience_folder_id: next.audienceFolderId ?? null,
          folder_id: next.folderId ?? null,
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
    return row ? this.hydrate(row) : null;
  }

  async getCampaignBySlug(slug: string): Promise<Campaign | null> {
    const row = this.db.prepare('SELECT * FROM campaigns WHERE slug = ?').get(slug) as
      | CampaignRow
      | undefined;
    return row ? this.hydrate(row) : null;
  }

  async listCampaigns(query: CampaignQuery = {}): Promise<Paged<Campaign>> {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (query.status) {
      where.push('status = @status');
      params.status = query.status;
    }
    if (query.search) {
      where.push('(title LIKE @search OR subject LIKE @search OR slug LIKE @search)');
      params.search = `%${query.search}%`;
    }
    if (query.from) {
      where.push("IFNULL(sent_at, created_at) >= @from");
      params.from = query.from;
    }
    if (query.to) {
      where.push("IFNULL(sent_at, created_at) <= @to");
      params.to = query.to;
    }
    if (query.folderId === 'unfiled') {
      where.push("(folder_id IS NULL OR folder_id = '')");
    } else if (query.folderId) {
      where.push('folder_id = @folder_id');
      params.folder_id = query.folderId;
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM campaigns ${clause}`).get(params) as { n: number }
    ).n;
    const rows = this.db
      .prepare(
        `SELECT * FROM campaigns ${clause} ORDER BY created_at DESC LIMIT @limit OFFSET @offset`,
      )
      .all({ ...params, limit: query.limit ?? 50, offset: query.offset ?? 0 }) as CampaignRow[];
    const items = await Promise.all(rows.map((r) => this.hydrate(r)));
    return { items, total };
  }

  async deleteCampaign(id: string): Promise<boolean> {
    await this.deleteDeliveries(id);
    this.db.prepare('DELETE FROM events WHERE campaign_id = ?').run(id);
    return this.db.prepare('DELETE FROM campaigns WHERE id = ?').run(id).changes > 0;
  }

  async findDueCampaigns(nowIso: string): Promise<Campaign[]> {
    const rows = this.db
      .prepare(
        "SELECT * FROM campaigns WHERE status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= ?",
      )
      .all(nowIso) as CampaignRow[];
    return Promise.all(rows.map((r) => this.hydrate(r)));
  }

  async findSendingCampaigns(): Promise<Campaign[]> {
    const rows = this.db
      .prepare("SELECT * FROM campaigns WHERE status = 'sending'")
      .all() as CampaignRow[];
    return Promise.all(rows.map((r) => this.hydrate(r)));
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

  async createEvent(event: TrackingEvent): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO events (id, campaign_id, subscriber_id, delivery_id, type, url, created_at)
         VALUES (@id, @campaign_id, @subscriber_id, @delivery_id, @type, @url, @created_at)`,
      )
      .run({
        id: event.id,
        campaign_id: event.campaignId,
        subscriber_id: event.subscriberId ?? null,
        delivery_id: event.deliveryId ?? null,
        type: event.type,
        url: event.url ?? null,
        created_at: event.createdAt,
      });
  }

  async campaignTrackingStats(campaignId: string): Promise<TrackingStats> {
    const row = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN type = 'open' THEN 1 ELSE 0 END) AS opens,
           COUNT(DISTINCT CASE WHEN type = 'open' THEN IFNULL(subscriber_id, id) END) AS unique_opens,
           SUM(CASE WHEN type = 'click' THEN 1 ELSE 0 END) AS clicks,
           COUNT(DISTINCT CASE WHEN type = 'click' THEN IFNULL(subscriber_id, id) END) AS unique_clicks
         FROM events WHERE campaign_id = ?`,
      )
      .get(campaignId) as {
      opens: number | null;
      unique_opens: number | null;
      clicks: number | null;
      unique_clicks: number | null;
    };
    const unsub = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT subscriber_id AS who FROM events
           WHERE campaign_id = ? AND type = 'unsubscribe' AND subscriber_id IS NOT NULL
           UNION
           SELECT id AS who FROM events
           WHERE campaign_id = ? AND type = 'unsubscribe' AND subscriber_id IS NULL
           UNION
           SELECT s.id AS who FROM deliveries d
           JOIN subscribers s ON s.id = d.subscriber_id
           WHERE d.campaign_id = ? AND d.status = 'sent'
             AND s.unsubscribed_at IS NOT NULL
             AND (d.sent_at IS NULL OR s.unsubscribed_at >= d.sent_at)
         )`,
      )
      .get(campaignId, campaignId, campaignId) as { n: number };
    return {
      opens: row.opens ?? 0,
      uniqueOpens: row.unique_opens ?? 0,
      clicks: row.clicks ?? 0,
      uniqueClicks: row.unique_clicks ?? 0,
      unsubscribes: unsub.n,
    };
  }

  async periodStats(query: PeriodQuery = {}): Promise<PeriodStats> {
    const from = query.from ?? null;
    const to = query.to ?? null;
    const bounds = { from, to };
    const newSubscribers = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM subscribers
           WHERE status != 'pending'
             AND (@from IS NULL OR COALESCE(confirmed_at, created_at) >= @from)
             AND (@to IS NULL OR COALESCE(confirmed_at, created_at) <= @to)`,
        )
        .get(bounds) as { n: number }
    ).n;
    const unsubscribes = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM subscribers
           WHERE unsubscribed_at IS NOT NULL
             AND (@from IS NULL OR unsubscribed_at >= @from)
             AND (@to IS NULL OR unsubscribed_at <= @to)`,
        )
        .get(bounds) as { n: number }
    ).n;
    const sentRow = this.db
      .prepare(
        `SELECT COUNT(*) AS sent, COUNT(DISTINCT campaign_id) AS campaigns
         FROM deliveries
         WHERE status = 'sent'
           AND sent_at IS NOT NULL
           AND (@from IS NULL OR sent_at >= @from)
           AND (@to IS NULL OR sent_at <= @to)`,
      )
      .get(bounds) as { sent: number; campaigns: number };
    const uniqueOpens = (
      this.db
        .prepare(
          `SELECT COUNT(DISTINCT IFNULL(subscriber_id, id)) AS n FROM events
           WHERE type = 'open'
             AND (@from IS NULL OR created_at >= @from)
             AND (@to IS NULL OR created_at <= @to)`,
        )
        .get(bounds) as { n: number }
    ).n;
    const uniqueClicks = (
      this.db
        .prepare(
          `SELECT COUNT(DISTINCT IFNULL(subscriber_id, id)) AS n FROM events
           WHERE type = 'click'
             AND (@from IS NULL OR created_at >= @from)
             AND (@to IS NULL OR created_at <= @to)`,
        )
        .get(bounds) as { n: number }
    ).n;
    return {
      newSubscribers,
      unsubscribes,
      sentCampaigns: sentRow.campaigns,
      sent: sentRow.sent,
      uniqueOpens,
      uniqueClicks,
    };
  }

  async createSequence(sequence: Sequence): Promise<Sequence> {
    this.db
      .prepare(
        `INSERT INTO sequences (id, name, trigger, trigger_value, enabled, created_at, updated_at)
         VALUES (@id, @name, @trigger, @trigger_value, @enabled, @created_at, @updated_at)`,
      )
      .run({
        id: sequence.id,
        name: sequence.name,
        trigger: sequence.trigger,
        trigger_value: sequence.triggerValue ?? null,
        enabled: sequence.enabled ? 1 : 0,
        created_at: sequence.createdAt,
        updated_at: sequence.updatedAt,
      });
    return sequence;
  }

  async updateSequence(id: string, patch: Partial<Sequence>): Promise<Sequence | null> {
    const current = await this.getSequence(id);
    if (!current) return null;
    const next = { ...current, ...patch, id };
    this.db
      .prepare(
        `UPDATE sequences SET name=@name, trigger=@trigger, trigger_value=@trigger_value,
         enabled=@enabled, updated_at=@updated_at WHERE id=@id`,
      )
      .run({
        id,
        name: next.name,
        trigger: next.trigger,
        trigger_value: next.triggerValue ?? null,
        enabled: next.enabled ? 1 : 0,
        updated_at: next.updatedAt,
      });
    return next;
  }

  async getSequence(id: string): Promise<Sequence | null> {
    const row = this.db.prepare('SELECT * FROM sequences WHERE id = ?').get(id) as
      | SequenceRow
      | undefined;
    return row ? toSequence(row) : null;
  }

  async listSequences(): Promise<Sequence[]> {
    const rows = this.db
      .prepare('SELECT * FROM sequences ORDER BY created_at DESC')
      .all() as SequenceRow[];
    return rows.map(toSequence);
  }

  async deleteSequence(id: string): Promise<boolean> {
    this.db.prepare('DELETE FROM sequence_steps WHERE sequence_id = ?').run(id);
    this.db.prepare('DELETE FROM sequence_enrollments WHERE sequence_id = ?').run(id);
    return this.db.prepare('DELETE FROM sequences WHERE id = ?').run(id).changes > 0;
  }

  async replaceSequenceSteps(sequenceId: string, steps: SequenceStep[]): Promise<SequenceStep[]> {
    const replace = this.db.transaction((items: SequenceStep[]) => {
      this.db.prepare('DELETE FROM sequence_steps WHERE sequence_id = ?').run(sequenceId);
      const insert = this.db.prepare(
        `INSERT INTO sequence_steps (id, sequence_id, position, delay_days, campaign_id)
         VALUES (@id, @sequence_id, @position, @delay_days, @campaign_id)`,
      );
      for (const step of items) {
        insert.run({
          id: step.id,
          sequence_id: step.sequenceId,
          position: step.position,
          delay_days: step.delayDays,
          campaign_id: step.campaignId,
        });
      }
    });
    replace(steps);
    return steps;
  }

  async listSequenceSteps(sequenceId: string): Promise<SequenceStep[]> {
    const rows = this.db
      .prepare('SELECT * FROM sequence_steps WHERE sequence_id = ? ORDER BY position ASC')
      .all(sequenceId) as SequenceStepRow[];
    return rows.map(toStep);
  }

  async createEnrollment(enrollment: SequenceEnrollment): Promise<SequenceEnrollment> {
    this.db
      .prepare(
        `INSERT INTO sequence_enrollments (id, sequence_id, subscriber_id, step_index, next_run_at, status, created_at)
         VALUES (@id, @sequence_id, @subscriber_id, @step_index, @next_run_at, @status, @created_at)`,
      )
      .run({
        id: enrollment.id,
        sequence_id: enrollment.sequenceId,
        subscriber_id: enrollment.subscriberId,
        step_index: enrollment.stepIndex,
        next_run_at: enrollment.nextRunAt,
        status: enrollment.status,
        created_at: enrollment.createdAt,
      });
    return enrollment;
  }

  async updateEnrollment(
    id: string,
    patch: Partial<SequenceEnrollment>,
  ): Promise<SequenceEnrollment | null> {
    const row = this.db.prepare('SELECT * FROM sequence_enrollments WHERE id = ?').get(id) as
      | EnrollmentRow
      | undefined;
    if (!row) return null;
    const next = { ...toEnrollment(row), ...patch, id };
    this.db
      .prepare(
        `UPDATE sequence_enrollments SET step_index=@step_index, next_run_at=@next_run_at, status=@status WHERE id=@id`,
      )
      .run({
        id,
        step_index: next.stepIndex,
        next_run_at: next.nextRunAt,
        status: next.status,
      });
    return next;
  }

  async getEnrollment(sequenceId: string, subscriberId: string): Promise<SequenceEnrollment | null> {
    const row = this.db
      .prepare('SELECT * FROM sequence_enrollments WHERE sequence_id = ? AND subscriber_id = ?')
      .get(sequenceId, subscriberId) as EnrollmentRow | undefined;
    return row ? toEnrollment(row) : null;
  }

  async listEnrollments(sequenceId: string): Promise<SequenceEnrollment[]> {
    const rows = this.db
      .prepare('SELECT * FROM sequence_enrollments WHERE sequence_id = ? ORDER BY created_at DESC')
      .all(sequenceId) as EnrollmentRow[];
    return rows.map(toEnrollment);
  }

  async findDueEnrollments(nowIso: string): Promise<SequenceEnrollment[]> {
    const rows = this.db
      .prepare(
        "SELECT * FROM sequence_enrollments WHERE status = 'active' AND next_run_at <= ?",
      )
      .all(nowIso) as EnrollmentRow[];
    return rows.map(toEnrollment);
  }

  async createTemplate(template: ContentTemplate): Promise<ContentTemplate> {
    if (this.findTemplateByName(template.name)) throw conflict('這個範本名稱已被使用');
    this.db
      .prepare(
        'INSERT INTO content_templates (id, name, html, created_at, updated_at) VALUES (@id, @name, @html, @created_at, @updated_at)',
      )
      .run({
        id: template.id,
        name: template.name,
        html: template.html,
        created_at: template.createdAt,
        updated_at: template.updatedAt,
      });
    return template;
  }

  async updateTemplate(id: string, patch: Partial<ContentTemplate>): Promise<ContentTemplate | null> {
    const current = await this.getTemplate(id);
    if (!current) return null;
    if (patch.name && this.findTemplateByName(patch.name, id)) throw conflict('這個範本名稱已被使用');
    const next: ContentTemplate = { ...current, ...patch, id };
    this.db
      .prepare('UPDATE content_templates SET name=@name, html=@html, updated_at=@updated_at WHERE id=@id')
      .run({ id, name: next.name, html: next.html, updated_at: next.updatedAt });
    return next;
  }

  async getTemplate(id: string): Promise<ContentTemplate | null> {
    const row = this.db.prepare('SELECT * FROM content_templates WHERE id = ?').get(id) as TemplateRow | undefined;
    return row ? toTemplate(row) : null;
  }

  async listTemplates(): Promise<ContentTemplate[]> {
    const rows = this.db
      .prepare('SELECT * FROM content_templates ORDER BY name COLLATE NOCASE')
      .all() as TemplateRow[];
    return rows.map(toTemplate);
  }

  async deleteTemplate(id: string): Promise<boolean> {
    const result = this.db.prepare('DELETE FROM content_templates WHERE id = ?').run(id);
    return result.changes > 0;
  }

  private findTemplateByName(name: string, exceptId?: string): ContentTemplate | undefined {
    const row = this.db
      .prepare('SELECT * FROM content_templates WHERE lower(name) = lower(?) AND id != ?')
      .get(name.trim(), exceptId ?? '') as TemplateRow | undefined;
    return row ? toTemplate(row) : undefined;
  }

  async getSetting(key: string): Promise<string | undefined> {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  async setSetting(key: string, value: string): Promise<void> {
    this.db
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }

  async createCampaignStarter(starter: CampaignStarter): Promise<CampaignStarter> {
    if (this.findStarterByName(starter.name)) throw conflict('這個模板名稱已被使用');
    this.db
      .prepare(
        'INSERT INTO campaign_starters (id, name, description, title, preheader, body_html, created_at, updated_at) VALUES (@id, @name, @description, @title, @preheader, @body_html, @created_at, @updated_at)',
      )
      .run({
        id: starter.id,
        name: starter.name,
        description: starter.description,
        title: starter.title,
        preheader: starter.preheader,
        body_html: starter.bodyHtml,
        created_at: starter.createdAt,
        updated_at: starter.updatedAt,
      });
    return starter;
  }

  async updateCampaignStarter(
    id: string,
    patch: Partial<CampaignStarter>,
  ): Promise<CampaignStarter | null> {
    const current = await this.getCampaignStarter(id);
    if (!current) return null;
    if (patch.name && this.findStarterByName(patch.name, id)) throw conflict('這個模板名稱已被使用');
    const next: CampaignStarter = { ...current, ...patch, id };
    this.db
      .prepare(
        'UPDATE campaign_starters SET name=@name, description=@description, title=@title, preheader=@preheader, body_html=@body_html, updated_at=@updated_at WHERE id=@id',
      )
      .run({
        id,
        name: next.name,
        description: next.description,
        title: next.title,
        preheader: next.preheader,
        body_html: next.bodyHtml,
        updated_at: next.updatedAt,
      });
    return next;
  }

  async getCampaignStarter(id: string): Promise<CampaignStarter | null> {
    const row = this.db.prepare('SELECT * FROM campaign_starters WHERE id = ?').get(id) as
      | StarterRow
      | undefined;
    return row ? toStarter(row) : null;
  }

  async listCampaignStarters(): Promise<CampaignStarter[]> {
    const rows = this.db
      .prepare('SELECT * FROM campaign_starters ORDER BY name COLLATE NOCASE')
      .all() as StarterRow[];
    return rows.map(toStarter);
  }

  async deleteCampaignStarter(id: string): Promise<boolean> {
    const result = this.db.prepare('DELETE FROM campaign_starters WHERE id = ?').run(id);
    return result.changes > 0;
  }

  private findStarterByName(name: string, exceptId?: string): CampaignStarter | undefined {
    const row = this.db
      .prepare('SELECT * FROM campaign_starters WHERE lower(name) = lower(?) AND id != ?')
      .get(name.trim(), exceptId ?? '') as StarterRow | undefined;
    return row ? toStarter(row) : undefined;
  }
}

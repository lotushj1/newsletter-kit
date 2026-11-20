import type {
  Campaign,
  CampaignStarter,
  ContentTemplate,
  Delivery,
  Folder,
  Sequence,
  SequenceEnrollment,
  SequenceStep,
  Subscriber,
  TrackingEvent,
} from './types.js';

/**
 * 實體 ⇄ 資料列的對照（STORE_DRIVER=insforge-tables 與搬移腳本共用）。
 *
 * 型別裡還沒有對應欄位的鍵（例如之後新增的欄位）存進 extra，讀回時合併回實體，
 * 不會在這個 driver 被默默丟掉；要查詢或排序的新欄位再補成正式欄位。
 */

type Kind = 'text' | 'lower' | 'int' | 'bool' | 'json' | 'array';

interface ColumnSpec {
  field: string;
  column: string;
  kind?: Kind;
  /** 寫入時 undefined／null 的替代值（NOT NULL 欄位）。 */
  writeDefault?: unknown;
  /** 讀回 null 時的替代值；沒設就省略這個鍵。 */
  readDefault?: unknown;
  /** 讀回 null 時保留 null（型別允許 null 的欄位，例如 scheduledAt）。 */
  keepNull?: boolean;
  /** 空字串存成 null（資料夾：空字串與未設定都代表未分類）。 */
  emptyAsNull?: boolean;
}

export interface EntitySpec {
  table: string;
  /** 主鍵欄位（同時是實體的欄位名）。 */
  key: string;
  columns: ColumnSpec[];
  /** 不存的欄位（例如由寄送紀錄即時算出的統計）。 */
  omit?: string[];
}

export type Row = Record<string, unknown>;

const SUBSCRIBERS: EntitySpec = {
  table: 'nk_subscribers',
  key: 'id',
  columns: [
    { field: 'id', column: 'id' },
    { field: 'email', column: 'email', kind: 'lower' },
    { field: 'name', column: 'name' },
    { field: 'status', column: 'status' },
    { field: 'tags', column: 'tags', kind: 'array', writeDefault: [], readDefault: [] },
    { field: 'folderId', column: 'folder_id', emptyAsNull: true },
    { field: 'source', column: 'source' },
    { field: 'createdAt', column: 'created_at' },
    { field: 'confirmedAt', column: 'confirmed_at' },
    { field: 'unsubscribedAt', column: 'unsubscribed_at' },
    { field: 'meta', column: 'meta', kind: 'json' },
  ],
};

const CAMPAIGNS: EntitySpec = {
  table: 'nk_campaigns',
  key: 'id',
  omit: ['stats', 'tracking'],
  columns: [
    { field: 'id', column: 'id' },
    { field: 'title', column: 'title', writeDefault: '' },
    { field: 'slug', column: 'slug' },
    { field: 'subject', column: 'subject', writeDefault: '' },
    { field: 'preheader', column: 'preheader' },
    { field: 'bodyMarkdown', column: 'body_markdown', writeDefault: '', readDefault: '' },
    { field: 'bodyHtml', column: 'body_html', writeDefault: '', readDefault: '' },
    { field: 'status', column: 'status' },
    { field: 'audienceTags', column: 'audience_tags', kind: 'array', writeDefault: [], readDefault: [] },
    { field: 'audienceCondition', column: 'audience_condition', kind: 'json' },
    { field: 'audienceFolderId', column: 'audience_folder_id', emptyAsNull: true },
    { field: 'folderId', column: 'folder_id', emptyAsNull: true },
    { field: 'scheduledAt', column: 'scheduled_at', keepNull: true },
    { field: 'sentAt', column: 'sent_at', keepNull: true },
    { field: 'createdAt', column: 'created_at' },
    { field: 'updatedAt', column: 'updated_at' },
  ],
};

const DELIVERIES: EntitySpec = {
  table: 'nk_deliveries',
  key: 'id',
  columns: [
    { field: 'id', column: 'id' },
    { field: 'campaignId', column: 'campaign_id' },
    { field: 'subscriberId', column: 'subscriber_id' },
    { field: 'email', column: 'email' },
    { field: 'status', column: 'status' },
    { field: 'attempts', column: 'attempts', kind: 'int', writeDefault: 0, readDefault: 0 },
    { field: 'error', column: 'error' },
    { field: 'providerMessageId', column: 'provider_message_id' },
    { field: 'sentAt', column: 'sent_at' },
    { field: 'claimId', column: 'claim_id' },
    { field: 'claimedAt', column: 'claimed_at' },
  ],
};

const EVENTS: EntitySpec = {
  table: 'nk_events',
  key: 'id',
  columns: [
    { field: 'id', column: 'id' },
    { field: 'campaignId', column: 'campaign_id' },
    { field: 'subscriberId', column: 'subscriber_id' },
    { field: 'deliveryId', column: 'delivery_id' },
    { field: 'type', column: 'type' },
    { field: 'url', column: 'url' },
    { field: 'createdAt', column: 'created_at' },
  ],
};

const SEQUENCES: EntitySpec = {
  table: 'nk_sequences',
  key: 'id',
  columns: [
    { field: 'id', column: 'id' },
    { field: 'name', column: 'name' },
    { field: 'trigger', column: 'trigger' },
    { field: 'triggerValue', column: 'trigger_value' },
    { field: 'enabled', column: 'enabled', kind: 'bool', writeDefault: true },
    { field: 'createdAt', column: 'created_at' },
    { field: 'updatedAt', column: 'updated_at' },
  ],
};

const SEQUENCE_STEPS: EntitySpec = {
  table: 'nk_sequence_steps',
  key: 'id',
  columns: [
    { field: 'id', column: 'id' },
    { field: 'sequenceId', column: 'sequence_id' },
    { field: 'position', column: 'position', kind: 'int' },
    { field: 'delayDays', column: 'delay_days', kind: 'int', writeDefault: 0, readDefault: 0 },
    { field: 'campaignId', column: 'campaign_id' },
  ],
};

const ENROLLMENTS: EntitySpec = {
  table: 'nk_enrollments',
  key: 'id',
  columns: [
    { field: 'id', column: 'id' },
    { field: 'sequenceId', column: 'sequence_id' },
    { field: 'subscriberId', column: 'subscriber_id' },
    { field: 'stepIndex', column: 'step_index', kind: 'int', writeDefault: 0, readDefault: 0 },
    { field: 'nextRunAt', column: 'next_run_at' },
    { field: 'status', column: 'status' },
    { field: 'createdAt', column: 'created_at' },
  ],
};

const FOLDERS: EntitySpec = {
  table: 'nk_folders',
  key: 'id',
  columns: [
    { field: 'id', column: 'id' },
    { field: 'name', column: 'name' },
    { field: 'kind', column: 'kind', writeDefault: 'subscribers', readDefault: 'subscribers' },
    { field: 'createdAt', column: 'created_at' },
  ],
};

const TEMPLATES: EntitySpec = {
  table: 'nk_templates',
  key: 'id',
  columns: [
    { field: 'id', column: 'id' },
    { field: 'name', column: 'name' },
    { field: 'html', column: 'html', writeDefault: '', readDefault: '' },
    { field: 'createdAt', column: 'created_at' },
    { field: 'updatedAt', column: 'updated_at' },
  ],
};

const STARTERS: EntitySpec = {
  table: 'nk_campaign_starters',
  key: 'id',
  columns: [
    { field: 'id', column: 'id' },
    { field: 'name', column: 'name' },
    { field: 'description', column: 'description', writeDefault: '', readDefault: '' },
    { field: 'title', column: 'title', writeDefault: '', readDefault: '' },
    { field: 'preheader', column: 'preheader', writeDefault: '', readDefault: '' },
    { field: 'bodyHtml', column: 'body_html', writeDefault: '', readDefault: '' },
    { field: 'createdAt', column: 'created_at' },
    { field: 'updatedAt', column: 'updated_at' },
  ],
};

export const SPECS = {
  subscribers: SUBSCRIBERS,
  campaigns: CAMPAIGNS,
  deliveries: DELIVERIES,
  events: EVENTS,
  sequences: SEQUENCES,
  sequenceSteps: SEQUENCE_STEPS,
  enrollments: ENROLLMENTS,
  folders: FOLDERS,
  templates: TEMPLATES,
  campaignStarters: STARTERS,
} as const;

export const SETTINGS_TABLE = 'nk_settings';

/** 實體型別對照，給呼叫端拿到正確的回傳型別。 */
export interface EntityTypes {
  subscribers: Subscriber;
  campaigns: Campaign;
  deliveries: Delivery;
  events: TrackingEvent;
  sequences: Sequence;
  sequenceSteps: SequenceStep;
  enrollments: SequenceEnrollment;
  folders: Folder;
  templates: ContentTemplate;
  campaignStarters: CampaignStarter;
}

function encode(spec: ColumnSpec, value: unknown): unknown {
  if (value === undefined || value === null) return spec.writeDefault ?? null;
  if (spec.emptyAsNull && value === '') return null;
  switch (spec.kind) {
    case 'lower':
      return typeof value === 'string' ? value.toLowerCase() : value;
    case 'int':
      return Number(value);
    case 'bool':
      return Boolean(value);
    case 'array':
      return Array.isArray(value) ? value.map(String) : [];
    default:
      return value;
  }
}

function fieldMap(spec: EntitySpec): Map<string, ColumnSpec> {
  return new Map(spec.columns.map((c) => [c.field, c]));
}

const FIELD_MAPS = new Map<EntitySpec, Map<string, ColumnSpec>>();
function fieldsOf(spec: EntitySpec): Map<string, ColumnSpec> {
  let map = FIELD_MAPS.get(spec);
  if (!map) {
    map = fieldMap(spec);
    FIELD_MAPS.set(spec, map);
  }
  return map;
}

/** 完整實體 → 資料列（所有欄位都有值，沒對應欄位的鍵進 extra）。 */
export function toRow(spec: EntitySpec, entity: object): Row {
  const source = entity as Record<string, unknown>;
  const row: Row = {};
  for (const column of spec.columns) row[column.column] = encode(column, source[column.field]);
  const fields = fieldsOf(spec);
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (fields.has(key) || spec.omit?.includes(key) || value === undefined) continue;
    extra[key] = value;
  }
  row.extra = extra;
  return row;
}

/** 部分更新 → 要改的欄位；沒對應欄位的鍵另外回傳（undefined 代表要移除）。 */
export function patchToRow(
  spec: EntitySpec,
  patch: object,
): { columns: Row; extra: Record<string, unknown> | null } {
  const fields = fieldsOf(spec);
  const columns: Row = {};
  let extra: Record<string, unknown> | null = null;
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (key === spec.key || spec.omit?.includes(key)) continue;
    const column = fields.get(key);
    if (column) {
      columns[column.column] = encode(column, value);
    } else {
      extra ??= {};
      extra[key] = value;
    }
  }
  return { columns, extra };
}

/** 把 extra 的修改套到既有 extra 上（undefined 代表移除這個鍵）。 */
export function mergeExtra(current: unknown, changes: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> =
    current && typeof current === 'object' && !Array.isArray(current) ? { ...(current as Record<string, unknown>) } : {};
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return next;
}

/** 資料列 → 實體。 */
export function fromRow<T>(spec: EntitySpec, row: Row): T {
  const extra = row.extra;
  const entity: Record<string, unknown> =
    extra && typeof extra === 'object' && !Array.isArray(extra) ? { ...(extra as Record<string, unknown>) } : {};
  for (const column of spec.columns) {
    const value = row[column.column];
    if (value === null || value === undefined) {
      if (column.readDefault !== undefined) entity[column.field] = structuredClone(column.readDefault);
      else if (column.keepNull) entity[column.field] = null;
      else delete entity[column.field];
      continue;
    }
    if (column.kind === 'int') entity[column.field] = Number(value);
    else if (column.kind === 'bool') entity[column.field] = value === true || value === 'true';
    else entity[column.field] = value;
  }
  return entity as T;
}

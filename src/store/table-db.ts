/**
 * InsForgeTableStore 用到的最小資料表介面。
 *
 * 正式環境由 src/core/insforge-table-db.ts 透過 @insforge/sdk（PostgREST）實作；
 * 測試用 PGlite 實作同一個介面，跑同一份 migration SQL。
 * 只放 store 真的需要的操作，換後端時對照這份清單即可。
 */

export type Scalar = string | number | boolean;

export type Filter =
  | { col: string; op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'; value: Scalar }
  | { col: string; op: 'in'; value: Scalar[] }
  | { col: string; op: 'is' | 'not.is'; value: null }
  /** 大小寫不分的 LIKE；value 是完整 pattern（呼叫端自己用 likeContains 跳脫）。 */
  | { col: string; op: 'ilike'; value: string }
  /** 陣列欄位：cs = 包含全部、ov = 有任一個重疊。 */
  | { col: string; op: 'cs' | 'ov'; value: string[] };

export interface Order {
  col: string;
  ascending: boolean;
}

export interface SelectOptions {
  filters?: Filter[] | undefined;
  /** 預設 '*'。 */
  columns?: string | undefined;
  order?: Order[] | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface TableDb {
  select<T = Record<string, unknown>>(table: string, options?: SelectOptions): Promise<T[]>;
  count(table: string, filters?: Filter[]): Promise<number>;
  /** 一次請求寫入（同一個交易）。ignoreDuplicates：主鍵已存在的列略過，不算錯。 */
  insert(table: string, rows: Record<string, unknown>[], options?: { ignoreDuplicates?: boolean }): Promise<void>;
  /** 主鍵衝突就更新（onConflict 欄位）；ignoreDuplicates 則略過已存在的列。 */
  upsert(
    table: string,
    rows: Record<string, unknown>[],
    options: { onConflict: string; ignoreDuplicates?: boolean },
  ): Promise<void>;
  /** 回傳實際更新到的列（更新後的值）。 */
  update<T = Record<string, unknown>>(table: string, patch: Record<string, unknown>, filters: Filter[]): Promise<T[]>;
  /** 回傳刪掉的列數。 */
  delete(table: string, filters: Filter[], keyColumn?: string): Promise<number>;
  /** 呼叫資料庫函式；回傳函式的回傳值（本專案的函式都回傳單一 JSON 值）。 */
  rpc<T = unknown>(fn: string, args?: Record<string, unknown>): Promise<T>;
}

/** PostgREST（InsForge）單次查詢最多回傳的列數；分頁用這個大小，拿到不足一頁就代表結束。 */
export const MAX_ROWS_PER_REQUEST = 1000;

/** 資料庫回傳的錯誤；code 是 Postgres SQLSTATE（例如 23505 唯一鍵衝突）。 */
export class TableDbError extends Error {
  override readonly name = 'TableDbError';
  constructor(
    message: string,
    readonly code?: string | undefined,
    readonly status?: number | undefined,
  ) {
    super(message);
  }
}

export function isUniqueViolation(error: unknown): boolean {
  if (error instanceof TableDbError) {
    if (error.code === '23505') return true;
    return /duplicate key|unique constraint/i.test(error.message);
  }
  return false;
}

/** 使用者輸入當成字面字串做「包含」比對：跳脫 LIKE 的 % _ \。 */
export function likeContains(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * InsForge 的閘道在查詢網址約 4KB 時回 502（實測：40 個排除名單 key 約 3,200 字元可以、
 * 50 個約 4,000 字元失敗）。in 條件放在網址上，所以一次帶的值要控制總長度，
 * 並留空間給網址其他部分。
 */
export const MAX_IN_FILTER_CHARS = 2500;

/** 依網址編碼後的長度切段（每段至少一個值）。 */
export function chunkByLength(values: string[], maxChars = MAX_IN_FILTER_CHARS): string[][] {
  const out: string[][] = [];
  let current: string[] = [];
  let length = 0;
  for (const value of values) {
    const size = encodeURIComponent(value).length + 3;
    if (current.length > 0 && length + size > maxChars) {
      out.push(current);
      current = [];
      length = 0;
    }
    current.push(value);
    length += size;
  }
  if (current.length > 0) out.push(current);
  return out;
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * 依 seq 遞增做 keyset 分頁讀完全部符合的列（offset 分頁在讀取期間有新增／刪除時會漏列）。
 * 資料表必須有 seq 欄位；回傳順序為寫入順序。
 */
export async function selectAllBySeq<T extends { seq?: unknown }>(
  db: TableDb,
  table: string,
  options: { filters?: Filter[] | undefined; columns?: string | undefined; limit?: number | undefined } = {},
): Promise<T[]> {
  const columns =
    options.columns && options.columns !== '*' && !options.columns.split(',').map((c) => c.trim()).includes('seq')
      ? `${options.columns},seq`
      : options.columns;
  const out: T[] = [];
  let after: number | null = null;
  const cap = options.limit ?? Number.POSITIVE_INFINITY;
  for (;;) {
    const want = Math.min(MAX_ROWS_PER_REQUEST, cap - out.length);
    if (want <= 0) break;
    const filters: Filter[] = [...(options.filters ?? [])];
    if (after !== null) filters.push({ col: 'seq', op: 'gt', value: after });
    const rows = await db.select<T>(table, {
      filters,
      columns,
      order: [{ col: 'seq', ascending: true }],
      limit: want,
    });
    out.push(...rows);
    if (rows.length < want) break;
    const last = rows[rows.length - 1]?.seq;
    if (typeof last !== 'number' && typeof last !== 'string') {
      throw new TableDbError(`${table} 分頁讀取需要 seq 欄位`);
    }
    after = Number(last);
  }
  return out;
}

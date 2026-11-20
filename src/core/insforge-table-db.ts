import { createAdminClient } from '@insforge/sdk';
import { logger } from './logger.js';
import { withTimeoutRetry } from './retry.js';
import {
  PER_ATTEMPT_TIMEOUT_MS,
  RETRY_ATTEMPTS,
  closeConnectionFetch,
  requireCreds,
} from './insforge.js';
import {
  MAX_ROWS_PER_REQUEST,
  TableDbError,
  type Filter,
  type SelectOptions,
  type TableDb,
} from '../store/table-db.js';

/** postgrest-js 的 builder 型別跟著 schema 泛型走；這層只轉呼叫，用寬鬆型別即可。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Builder = any;

interface PostgrestResult {
  data: unknown;
  error: { message?: string; code?: string } | null;
  status?: number;
  count?: number | null;
}

/** 4xx（參數、權限、唯一鍵衝突）重試沒有意義；逾時、斷線、5xx 才重試。 */
function isTransient(error: unknown): boolean {
  if (error instanceof TableDbError) {
    const status = error.status ?? 0;
    return status === 0 || status === 408 || status === 429 || status >= 500;
  }
  return true;
}

/** Postgres 陣列字面值（cs／ov 用），每個元素都加引號，標籤裡有逗號、空白也不會被拆開。 */
function arrayLiteral(values: string[]): string {
  return `{${values.map((v) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')}}`;
}

function applyFilters(query: Builder, filters: Filter[] = []): Builder {
  let q = query;
  for (const f of filters) {
    switch (f.op) {
      case 'eq':
      case 'neq':
      case 'gt':
      case 'gte':
      case 'lt':
      case 'lte':
        q = q[f.op](f.col, f.value);
        break;
      case 'in':
        q = q.in(f.col, f.value);
        break;
      case 'is':
        q = q.is(f.col, null);
        break;
      case 'not.is':
        q = q.not(f.col, 'is', null);
        break;
      case 'ilike':
        q = q.ilike(f.col, f.value);
        break;
      case 'cs':
      case 'ov':
        q = q.filter(f.col, f.op, arrayLiteral(f.value));
        break;
      default: {
        const exhaustive: never = f;
        throw new Error(`不支援的條件：${JSON.stringify(exhaustive)}`);
      }
    }
  }
  return q;
}

function unwrap(result: PostgrestResult, label: string): PostgrestResult {
  if (result.error) {
    throw new TableDbError(
      `${label}：${result.error.message ?? '未知錯誤'}`,
      result.error.code || undefined,
      result.status,
    );
  }
  return result;
}

/**
 * 用 @insforge/sdk 的 database API（PostgREST）實作 TableDb。
 * 每次請求 8 秒逾時，逾時或 5xx 重試（共 3 次），重試前重建 client 丟掉可能已死的連線。
 * store 這邊的寫入都設計成重送安全（條件更新、ignoreDuplicates、同 claim id 可重領）。
 */
export function createInsForgeTableDb(creds: { url: string; apiKey: string } = requireCreds()): TableDb {
  const { url, apiKey } = creds;
  const createClient = () =>
    createAdminClient({
      baseUrl: url,
      apiKey,
      timeout: PER_ATTEMPT_TIMEOUT_MS,
      retryCount: 0,
      fetch: closeConnectionFetch,
    });
  let admin = createClient();

  function run<T>(label: string, task: (database: Builder) => Promise<T>): Promise<T> {
    return withTimeoutRetry(() => task(admin.database), {
      label,
      attempts: RETRY_ATTEMPTS,
      timeoutMs: PER_ATTEMPT_TIMEOUT_MS + 1000,
      retryable: isTransient,
      onRetry: (attempt, error) => {
        logger.warn(`InsForge ${label}失敗，重試中`, { attempt, error: error.message });
        admin = createClient();
      },
    });
  }

  return {
    select<T>(table: string, options: SelectOptions = {}) {
      return run(`讀取 ${table}`, async (db) => {
        let q = applyFilters(db.from(table).select(options.columns ?? '*'), options.filters);
        for (const order of options.order ?? []) q = q.order(order.col, { ascending: order.ascending });
        const limit = Math.min(options.limit ?? MAX_ROWS_PER_REQUEST, MAX_ROWS_PER_REQUEST);
        const offset = options.offset ?? 0;
        q = q.range(offset, offset + limit - 1);
        const { data } = unwrap(await q, `讀取 ${table}`);
        if (!Array.isArray(data)) throw new TableDbError(`讀取 ${table}：回傳格式異常`);
        return data as T[];
      });
    },

    count(table, filters) {
      return run(`計數 ${table}`, async (db) => {
        const q = applyFilters(db.from(table).select('*', { count: 'exact', head: true }), filters);
        const { count } = unwrap(await q, `計數 ${table}`);
        if (typeof count !== 'number') throw new TableDbError(`計數 ${table}：沒有回傳筆數`);
        return count;
      });
    },

    async insert(table, rows, options = {}) {
      if (rows.length === 0) return;
      await run(`寫入 ${table}`, async (db) => {
        const q = options.ignoreDuplicates
          ? db.from(table).upsert(rows, { onConflict: 'id', ignoreDuplicates: true })
          : db.from(table).insert(rows);
        unwrap(await q, `寫入 ${table}`);
      });
    },

    async upsert(table, rows, options) {
      if (rows.length === 0) return;
      await run(`寫入 ${table}`, async (db) => {
        const q = db.from(table).upsert(rows, {
          onConflict: options.onConflict,
          ignoreDuplicates: options.ignoreDuplicates ?? false,
        });
        unwrap(await q, `寫入 ${table}`);
      });
    },

    update<T>(table: string, patch: Record<string, unknown>, filters: Filter[]) {
      return run(`更新 ${table}`, async (db) => {
        const q = applyFilters(db.from(table).update(patch), filters).select('*');
        const { data } = unwrap(await q, `更新 ${table}`);
        if (!Array.isArray(data)) throw new TableDbError(`更新 ${table}：沒有回傳更新結果，無法確認是否寫入`);
        return data as T[];
      });
    },

    delete(table, filters, keyColumn = 'id') {
      return run(`刪除 ${table}`, async (db) => {
        const q = applyFilters(db.from(table).delete(), filters).select(keyColumn);
        const { data } = unwrap(await q, `刪除 ${table}`);
        return Array.isArray(data) ? data.length : 0;
      });
    },

    rpc<T>(fn: string, args: Record<string, unknown> = {}) {
      return run(`呼叫 ${fn}`, async (db) => {
        const { data } = unwrap(await db.rpc(fn, args), `呼叫 ${fn}`);
        return data as T;
      });
    },
  };
}

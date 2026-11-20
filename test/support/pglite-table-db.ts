import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import {
  MAX_ROWS_PER_REQUEST,
  TableDbError,
  type Filter,
  type SelectOptions,
  type TableDb,
} from '../../src/store/table-db.js';

/**
 * 測試用 TableDb：在記憶體裡跑真的 Postgres（PGlite），套用 migrations/ 的 SQL。
 * 行為對齊 PostgREST：單次最多回 MAX_ROWS_PER_REQUEST 列、錯誤帶 SQLSTATE。
 */

const MIGRATIONS_DIR = join(import.meta.dirname, '..', '..', 'migrations');

/** 只套用逐表 store 需要的 migration（nk_snapshots 那支跟這裡無關）。 */
export function tableMigrationSql(): string {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql') && name >= '20261108')
    .sort()
    .map((name) => readFileSync(join(MIGRATIONS_DIR, name), 'utf8'))
    .join('\n');
}

/** 實測 3,100 字元可以、3,900 字元失敗；取保守值。 */
const URL_FILTER_LIMIT = 3000;

const ident = (name: string): string => `"${name.replace(/"/g, '""')}"`;

let template: Promise<Blob | File> | null = null;

/** 第一次建立後把資料目錄存起來，之後每個測試直接載入（比每次重跑 migration 快很多）。 */
async function templateDump(): Promise<Blob | File> {
  template ??= (async () => {
    const pg = new PGlite();
    await pg.exec(tableMigrationSql());
    const dump = await pg.dumpDataDir('none');
    await pg.close();
    return dump;
  })();
  return template;
}

export class PgliteTableDb implements TableDb {
  private readonly columnTypes = new Map<string, Promise<Map<string, string>>>();
  private readonly fnArgs = new Map<string, Promise<{ name: string; type: string }[]>>();
  /** 測試可以檢查發出的操作（例如確認某個寫入只發了一次請求）。 */
  readonly calls: { op: string; target: string }[] = [];

  constructor(readonly pg: PGlite) {}

  static async create(): Promise<PgliteTableDb> {
    const pg = new PGlite({ loadDataDir: await templateDump() });
    await pg.waitReady;
    return new PgliteTableDb(pg);
  }

  async close(): Promise<void> {
    await this.pg.close();
  }

  private types(table: string): Promise<Map<string, string>> {
    let found = this.columnTypes.get(table);
    if (!found) {
      found = this.pg
        .query<{ column_name: string; data_type: string }>(
          `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
          [table],
        )
        .then((r) => new Map(r.rows.map((row) => [row.column_name, row.data_type])));
      this.columnTypes.set(table, found);
    }
    return found;
  }

  /** jsonb 欄位要傳 JSON 字串；其餘照原值（陣列會被當成 Postgres 陣列）。 */
  private async param(table: string, column: string, value: unknown): Promise<unknown> {
    if (value === null || value === undefined) return null;
    const type = (await this.types(table)).get(column);
    if (type === 'jsonb' || type === 'json') return JSON.stringify(value);
    return value;
  }

  private async where(table: string, filters: Filter[] = [], params: unknown[]): Promise<string> {
    const parts: string[] = [];
    for (const f of filters) {
      const col = ident(f.col);
      const next = () => `$${params.length}`;
      switch (f.op) {
        case 'eq':
        case 'neq':
        case 'gt':
        case 'gte':
        case 'lt':
        case 'lte': {
          const op = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' }[f.op];
          params.push(await this.param(table, f.col, f.value));
          parts.push(`${col} ${op} ${next()}`);
          break;
        }
        case 'in': {
          // 模擬 InsForge 閘道的網址長度上限（約 4KB 回 502），讓單元測試抓得到太長的 in 條件。
          const urlLength = f.value.reduce((sum: number, v) => sum + encodeURIComponent(String(v)).length + 3, 0);
          if (urlLength > URL_FILTER_LIMIT) {
            throw new TableDbError(`in 條件太長（${urlLength} 字元），InsForge 會回 502`, undefined, 502);
          }
          params.push(f.value);
          parts.push(`${col} = ANY(${next()})`);
          break;
        }
        case 'is':
          parts.push(`${col} IS NULL`);
          break;
        case 'not.is':
          parts.push(`${col} IS NOT NULL`);
          break;
        case 'ilike':
          params.push(f.value);
          parts.push(`${col} ILIKE ${next()}`);
          break;
        case 'cs':
          params.push(f.value);
          parts.push(`${col} @> ${next()}::text[]`);
          break;
        case 'ov':
          params.push(f.value);
          parts.push(`${col} && ${next()}::text[]`);
          break;
      }
    }
    return parts.length > 0 ? `WHERE ${parts.join(' AND ')}` : '';
  }

  private async run<T>(sql: string, params: unknown[]): Promise<T[]> {
    try {
      const result = await this.pg.query<T>(sql, params);
      return result.rows;
    } catch (error) {
      const e = error as { message?: string; code?: string };
      throw new TableDbError(e.message ?? String(error), e.code, e.code === '23505' ? 409 : 400);
    }
  }

  async select<T>(table: string, options: SelectOptions = {}): Promise<T[]> {
    this.calls.push({ op: 'select', target: table });
    const params: unknown[] = [];
    const columns = !options.columns || options.columns === '*' ? '*' : options.columns.split(',').map((c) => ident(c.trim())).join(', ');
    const order = (options.order ?? []).map((o) => `${ident(o.col)} ${o.ascending ? 'ASC' : 'DESC'}`);
    const limit = Math.min(options.limit ?? MAX_ROWS_PER_REQUEST, MAX_ROWS_PER_REQUEST);
    const sql = `SELECT ${columns} FROM ${ident(table)} ${await this.where(table, options.filters, params)}
      ${order.length > 0 ? `ORDER BY ${order.join(', ')}` : ''} LIMIT ${limit} OFFSET ${options.offset ?? 0}`;
    return this.run<T>(sql, params);
  }

  async count(table: string, filters: Filter[] = []): Promise<number> {
    this.calls.push({ op: 'count', target: table });
    const params: unknown[] = [];
    const rows = await this.run<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${ident(table)} ${await this.where(table, filters, params)}`,
      params,
    );
    return rows[0]?.n ?? 0;
  }

  private async insertSql(
    table: string,
    rows: Record<string, unknown>[],
    conflict: string,
  ): Promise<{ sql: string; params: unknown[] }> {
    const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    const params: unknown[] = [];
    const values: string[] = [];
    for (const row of rows) {
      const cells: string[] = [];
      for (const column of columns) {
        if (!(column in row)) {
          cells.push('DEFAULT');
          continue;
        }
        params.push(await this.param(table, column, row[column]));
        cells.push(`$${params.length}`);
      }
      values.push(`(${cells.join(', ')})`);
    }
    return {
      sql: `INSERT INTO ${ident(table)} (${columns.map(ident).join(', ')}) VALUES ${values.join(', ')} ${conflict}`,
      params,
    };
  }

  async insert(table: string, rows: Record<string, unknown>[], options: { ignoreDuplicates?: boolean } = {}): Promise<void> {
    this.calls.push({ op: 'insert', target: table });
    if (rows.length === 0) return;
    const { sql, params } = await this.insertSql(table, rows, options.ignoreDuplicates ? 'ON CONFLICT DO NOTHING' : '');
    await this.run(sql, params);
  }

  async upsert(
    table: string,
    rows: Record<string, unknown>[],
    options: { onConflict: string; ignoreDuplicates?: boolean },
  ): Promise<void> {
    this.calls.push({ op: 'upsert', target: table });
    if (rows.length === 0) return;
    const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((c) => c !== options.onConflict);
    const action = options.ignoreDuplicates || columns.length === 0
      ? 'DO NOTHING'
      : `DO UPDATE SET ${columns.map((c) => `${ident(c)} = EXCLUDED.${ident(c)}`).join(', ')}`;
    const { sql, params } = await this.insertSql(table, rows, `ON CONFLICT (${ident(options.onConflict)}) ${action}`);
    await this.run(sql, params);
  }

  async update<T>(table: string, patch: Record<string, unknown>, filters: Filter[]): Promise<T[]> {
    this.calls.push({ op: 'update', target: table });
    const params: unknown[] = [];
    const sets: string[] = [];
    for (const [column, value] of Object.entries(patch)) {
      params.push(await this.param(table, column, value));
      sets.push(`${ident(column)} = $${params.length}`);
    }
    const sql = `UPDATE ${ident(table)} SET ${sets.join(', ')} ${await this.where(table, filters, params)} RETURNING *`;
    return this.run<T>(sql, params);
  }

  async delete(table: string, filters: Filter[]): Promise<number> {
    this.calls.push({ op: 'delete', target: table });
    const params: unknown[] = [];
    const rows = await this.run(`DELETE FROM ${ident(table)} ${await this.where(table, filters, params)} RETURNING 1`, params);
    return rows.length;
  }

  private args(fn: string): Promise<{ name: string; type: string }[]> {
    let found = this.fnArgs.get(fn);
    if (!found) {
      found = this.pg
        .query<{ names: string[] | null; types: string[] }>(
          `SELECT proargnames AS names, proargtypes::regtype[]::text[] AS types
             FROM pg_proc WHERE proname = $1 AND pronamespace = 'public'::regnamespace`,
          [fn],
        )
        .then((r) => {
          const row = r.rows[0];
          if (!row) throw new TableDbError(`找不到函式 ${fn}`, '42883', 404);
          return (row.names ?? []).map((name, i) => ({ name, type: row.types[i] ?? 'text' }));
        });
      this.fnArgs.set(fn, found);
    }
    return found;
  }

  async rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ op: 'rpc', target: fn });
    const declared = await this.args(fn);
    const params: unknown[] = [];
    const named: string[] = [];
    for (const { name, type } of declared) {
      if (!(name in args)) continue;
      const value = args[name];
      params.push(type === 'jsonb' && value !== null && value !== undefined ? JSON.stringify(value) : value ?? null);
      named.push(`${ident(name)} => $${params.length}::${type}`);
    }
    const rows = await this.run<{ v: T }>(`SELECT public.${ident(fn)}(${named.join(', ')}) AS v`, params);
    return rows[0]?.v as T;
  }
}

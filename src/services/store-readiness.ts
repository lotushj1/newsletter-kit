import { AppError } from '../core/errors.js';
import { newId, nowIso } from '../core/ids.js';
import { logger } from '../core/logger.js';
import type { SchemaCheck, Store } from '../store/types.js';
import type { StoreReadiness } from './readiness-types.js';
import type { ServiceContext } from './context.js';

/**
 * 資料層能不能寫：寄送與公開訂閱開始前先確認，寫不進去就明確擋下（503），
 * 不要等寫到一半才失敗，也不要假裝成功。
 *
 * - 整份快照的 store（insforge）本身有完整性檢查與停寫機制，直接看 integrityStatus，不另外寫入
 *   （每次寫入都要重寫整份快照，太貴）。
 * - 其他 store 寫一個探測值到 settings 再讀回來；InsForge 逐表再加查 schema 版本。
 * 正常的結果依 store 快取 STORE_CHECK_TTL_MS，過期才重查；有問題的結果下次一定重查。
 */

/** 寫入探測用的設定鍵：每次檢查寫一個新值再讀回來。 */
export const READINESS_PROBE_KEY = 'readiness_probe';
/** 檢查結果沿用多久（毫秒）。 */
export const STORE_CHECK_TTL_MS = 30_000;

/**
 * 缺了也不影響訂閱與寄送的資料表：只列為提醒，不擋寄送。
 * 操作紀錄寫不進去時只記警告（見 services/audit.ts），不能因為它沒建立就停掉寄送。
 */
const OPTIONAL_SCHEMA = new Set(['nk_audit_log']);
/** 公開訂閱被擋下時的錯誤代碼（API 回應的 code）。 */
export const STORE_UNAVAILABLE = 'store_unavailable';

export type { StoreReadiness } from './readiness-types.js';

const cache = new WeakMap<Store, { result: StoreReadiness; at: number }>();

function integrityOf(store: Store): { ok: boolean; reason?: string } | null {
  return (store as { integrityStatus?: () => { ok: boolean; reason?: string } }).integrityStatus?.() ?? null;
}

function remember(store: Store, result: StoreReadiness): StoreReadiness {
  const previous = cache.get(store)?.result;
  if (previous?.ok !== false && !result.ok) {
    logger.error('資料層無法寫入，暫停寄送與公開訂閱', { driver: result.driver, problems: result.problems });
  } else if (previous?.ok === false && result.ok) {
    logger.info('資料層恢復可寫入', { driver: result.driver });
  }
  cache.set(store, { result, at: Date.now() });
  return result;
}

/**
 * 檢查資料層；快取還新就直接回快取。full=true 一定重查，並逐一確認資料表與函式（後台運作狀態用）。
 * 不會丟錯：問題一律放在 problems。
 */
export async function checkStoreReadiness(
  ctx: ServiceContext,
  options: { full?: boolean } = {},
): Promise<StoreReadiness> {
  // 只沿用「正常」的結果；有問題時每次都重查，資料庫一恢復就能馬上續寄、受理訂閱。
  const cached = cache.get(ctx.store);
  if (!options.full && cached?.result.ok && Date.now() - cached.at < STORE_CHECK_TTL_MS) return cached.result;

  const problems: string[] = [];
  const warnings: string[] = [];
  const integrity = integrityOf(ctx.store);
  if (integrity && !integrity.ok) problems.push(`資料層完整性異常：${integrity.reason ?? '未知原因'}`);

  let schema: SchemaCheck | null = null;
  if (ctx.store.checkSchema) {
    try {
      schema = await ctx.store.checkSchema({ full: options.full });
    } catch (error) {
      schema = { version: null, expectedVersion: 0, missing: [], error: (error as Error).message };
    }
    if (schema.version !== schema.expectedVersion) {
      problems.push(
        schema.version === null
          ? `讀不到資料表版本${schema.error ? `（${schema.error}）` : ''}`
          : `資料表版本 ${schema.version} 與程式需要的 ${schema.expectedVersion} 不符，請套用最新的 migrations`,
      );
    }
    const missing = schema.missing.filter((name) => name !== 'nk_tables_schema_version()');
    const blocking = missing.filter((name) => !OPTIONAL_SCHEMA.has(name));
    const optional = missing.filter((name) => OPTIONAL_SCHEMA.has(name));
    if (blocking.length > 0) problems.push(`缺少或讀不到：${blocking.join('、')}`);
    if (optional.length > 0) warnings.push(`缺少 ${optional.join('、')}，請套用最新的 migrations（訂閱與寄送不受影響）`);
  }

  let writable: boolean | null = null;
  if (integrity) {
    writable = integrity.ok;
  } else {
    const value = `${nowIso()} ${newId('probe')}`;
    try {
      await ctx.store.setSetting(READINESS_PROBE_KEY, value);
      writable = (await ctx.store.getSetting(READINESS_PROBE_KEY)) === value;
      if (!writable) problems.push('寫入後讀回的值不一致');
    } catch (error) {
      writable = false;
      problems.push(`寫入失敗：${(error as Error).message}`);
    }
  }

  return remember(ctx.store, {
    ok: problems.length === 0,
    driver: ctx.store.driver,
    checkedAt: nowIso(),
    writable,
    integrity: integrity ? (integrity.ok ? 'ok' : 'frozen') : null,
    schema,
    problems,
    ...(warnings.length > 0 ? { warnings } : {}),
  });
}

/**
 * 最近一次檢查（或寄送中途）發現的寫入問題；同步讀快取，給每一批寄送前判斷。
 * 完整性異常不在這裡回（寄送端另外即時檢查 integrityStatus）。
 */
export function storeProblem(ctx: ServiceContext): string | null {
  const cached = cache.get(ctx.store)?.result;
  if (!cached || cached.ok) return null;
  const problems = cached.problems.filter((p) => !p.startsWith('資料層完整性異常'));
  return problems.length > 0 ? problems.join('；') : null;
}

/** 寄送途中寫回失敗：記下來，下一批與之後的寄送先擋住，直到重新檢查通過。 */
export function noteStoreWriteFailure(ctx: ServiceContext, message: string): void {
  const cached = cache.get(ctx.store)?.result;
  remember(ctx.store, {
    ok: false,
    driver: ctx.store.driver,
    checkedAt: nowIso(),
    writable: false,
    integrity: cached?.integrity ?? null,
    schema: cached?.schema ?? null,
    problems: [`寫入失敗：${message}`],
  });
}

/** 公開訂閱前呼叫：資料層寫不進去就回 503，不讓訪客以為訂閱成功。 */
export async function assertAcceptingSubscriptions(ctx: ServiceContext): Promise<void> {
  const readiness = await checkStoreReadiness(ctx);
  if (readiness.ok) return;
  throw new AppError('目前暫停受理新訂閱：資料庫暫時無法寫入，請稍後再試。', 503, STORE_UNAVAILABLE);
}

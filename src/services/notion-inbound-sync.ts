import { createHash } from 'node:crypto';
import { logger } from '../core/logger.js';
import { nowIso } from '../core/ids.js';
import { normalizeTags } from '../core/validate.js';
import type { Subscriber } from '../store/types.js';
import type { ServiceContext } from './context.js';
import { enrollSubscriber } from './enroll.js';
import { NOTION_SUBSCRIBED, NOTION_UNSUBSCRIBED, readNotionEnv, type NotionEnv } from './notion-sync.js';
import { withConsent } from './consent.js';
import { recordUnsubscribe } from './suppression.js';

/**
 * 從 Notion「電子報訂閱會員」資料庫把新訂閱與退訂拉回電子報系統。
 *
 * 官網（與 Portaly）的訂閱者會被同步進這個 Notion 資料庫，但不會直接進電子報系統；
 * 這個服務掛在排程器的 tick 裡（不受 SCHEDULER_ENABLED 影響，因為它不寄信），
 * 每 5 分鐘查一次「上次之後有被修改的列」。
 *
 * 保守規則：
 * - 只新增「同步開始之後才訂閱」的人；更早的列若不在名單內（例如刻意清除的舊會員）一律略過。
 * - Notion 已退訂 → 電子報系統跟著退訂。但一次要退訂的人超過上限（預設 20）時整批暫停、
 *   游標不前進，等後台按「套用這些退訂」才執行；防止在 Notion 批次誤改狀態就清掉名單。
 * - 電子報系統裡已退訂的人，只有 Notion 的訂閱日晚於退訂時間才會恢復訂閱（避免被舊資料翻回來）。
 * - 退信／檢舉等排除名單裡的地址不會被加回來。
 * - 不寄確認信、不回寫 Notion（資料本來就從 Notion 來）。
 * - 由 Notion 匯入的訂閱者 id 由 email 決定，多個實例同時匯入也不會出現重複的人。
 */

const SETTING_KEY = 'notion_inbound_sync';
const INTERVAL_MS = 5 * 60 * 1000;
/** 第一次執行時往回看多久（涵蓋部署前那段時間的新訂閱）。 */
const FIRST_RUN_LOOKBACK_MS = 48 * 60 * 60 * 1000;
const PAGE_SIZE = 100;
const MAX_PAGES = 5;
const NOTION_VERSION = '2022-06-28';
const TIMEOUT_MS = 10_000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_MAX_UNSUBSCRIBES = 20;

type FetchLike = typeof fetch;

interface SyncState {
  /** 只新增這個時間之後才訂閱的人。 */
  since: string;
  /** 下次查詢的起點（Notion last_edited_time，分鐘精度）。 */
  cursor: string;
  /**
   * 一輪讀不完（超過 MAX_PAGES）時，Notion 的分頁游標，下一輪從這裡接著讀。
   * Notion 的修改時間只到分鐘，批次修改大量列時它們時間相同，
   * 只靠時間游標會每輪重讀同一批、永遠讀不到後面的新訂閱。
   */
  pageCursor?: string | undefined;
  lastRunAt?: string | undefined;
  /** 一次退訂太多人而暫停時的紀錄；套用或在 Notion 改回後清掉。 */
  held?: { at: string; unsubscribes: number } | undefined;
  /** 後台確認後，下一輪最多可套用幾筆退訂。用過即清。 */
  approvedUnsubscribes?: number | undefined;
}

export interface NotionInboundSummary {
  ran: boolean;
  checked: number;
  added: number;
  unsubscribed: number;
  resubscribed: number;
  skippedOld: number;
  skippedSuppressed: number;
  skippedConflict: number;
  /** Notion 上是「訂閱中」，但這裡是退訂或退信：要本人重新訂閱並確認，不自動加回。 */
  needsConfirmation?: number | undefined;
  invalid: number;
  /** 這一輪因為退訂人數超過上限而整批暫停。 */
  held?: boolean | undefined;
  pendingUnsubscribes?: number | undefined;
  reason?: string | undefined;
}

export interface NotionInboundStatus {
  enabled: boolean;
  lastRunAt: string | null;
  maxUnsubscribesPerRun: number;
  held: { at: string; unsubscribes: number } | null;
}

interface NotionRow {
  email: string;
  status: string | null;
  subscribedAt: string;
  createdTime: string;
  lastEditedTime: string;
  sources: string[];
  name: string | undefined;
}

const emptySummary = (reason?: string): NotionInboundSummary => ({
  ran: false,
  checked: 0,
  added: 0,
  unsubscribed: 0,
  resubscribed: 0,
  skippedOld: 0,
  skippedSuppressed: 0,
  skippedConflict: 0,
  invalid: 0,
  reason,
});

let lastAttemptAt = 0;

/** 測試用：清掉這個程序內的節流紀錄。 */
export function resetNotionInboundThrottle(): void {
  lastAttemptAt = 0;
}

/** 單一輪最多自動套用幾筆退訂；NOTION_INBOUND_MAX_UNSUBSCRIBES 可調整。 */
export function maxUnsubscribesPerRun(): number {
  const raw = process.env.NOTION_INBOUND_MAX_UNSUBSCRIBES?.trim();
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_MAX_UNSUBSCRIBES;
}

export function isNotionInboundEnabled(): boolean {
  return process.env.NOTION_INBOUND_SYNC?.trim().toLowerCase() !== 'false' && readNotionEnv() !== null;
}

/** 由 Notion 匯入的訂閱者用固定 id，多個實例同時匯入同一人時合併成同一筆。 */
export function notionSubscriberId(email: string): string {
  return `sub_${createHash('sha256').update(`notion:${email}`).digest('hex').slice(0, 32)}`;
}

/** 來源對應到名單標籤，跟 11/3 匯入時的標籤一致。 */
function sourceTag(source: string): string {
  if (source.startsWith('創作邦官網')) return '創作邦官網';
  if (source.toLowerCase() === 'portaly') return 'portaly';
  return '';
}

function plainText(value: any): string {
  return Array.isArray(value) ? value.map((part) => part?.plain_text ?? '').join('') : '';
}

function parseRow(page: any): NotionRow | null {
  const props = page?.properties ?? {};
  const email = plainText(props.email?.title ?? props.email?.rich_text).trim().toLowerCase();
  if (!email) return null;
  const dateStart: string | undefined = props['訂閱日']?.date?.start ?? undefined;
  const createdTime: string = page.created_time;
  // 只有日期沒有時間的訂閱日，用建立時間代替（比較精確）。
  const subscribedAt = dateStart && dateStart.includes('T') ? new Date(dateStart).toISOString() : createdTime;
  return {
    email,
    status: props['狀態']?.select?.name ?? null,
    subscribedAt,
    createdTime,
    lastEditedTime: page.last_edited_time,
    sources: (props['來源']?.multi_select ?? []).map((item: any) => String(item?.name ?? '')).filter(Boolean),
    name: plainText(props['名稱']?.rich_text).trim() || undefined,
  };
}

async function queryChanged(
  env: NotionEnv,
  fetchImpl: FetchLike,
  cursor: string,
  startCursor: string | undefined,
): Promise<{ results: any[]; hasMore: boolean; nextCursor: string | undefined }> {
  const res = await fetchImpl(`https://api.notion.com/v1/databases/${env.databaseId}/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      filter: { timestamp: 'last_edited_time', last_edited_time: { on_or_after: cursor } },
      sorts: [{ timestamp: 'last_edited_time', direction: 'ascending' }],
      page_size: PAGE_SIZE,
      ...(startCursor ? { start_cursor: startCursor } : {}),
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Notion 查詢失敗 ${res.status} ${text.slice(0, 200)}`);
  }
  const body = (await res.json()) as { results?: any[]; has_more?: boolean; next_cursor?: string | null };
  return { results: body.results ?? [], hasMore: !!body.has_more, nextCursor: body.next_cursor ?? undefined };
}

async function readState(ctx: ServiceContext, now: number): Promise<{ state: SyncState; fresh: boolean }> {
  const raw = await ctx.store.getSetting(SETTING_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<SyncState>;
      if (parsed.since && parsed.cursor) return { state: parsed as SyncState, fresh: false };
    } catch {
      // 壞掉的狀態就當第一次執行
    }
  }
  const since = new Date(now - FIRST_RUN_LOOKBACK_MS).toISOString();
  return { state: { since, cursor: since }, fresh: true };
}

async function applyRow(ctx: ServiceContext, row: NotionRow, since: string, summary: NotionInboundSummary): Promise<void> {
  if (!EMAIL_PATTERN.test(row.email)) {
    summary.invalid += 1;
    return;
  }
  const existing = await ctx.store.getSubscriberByEmail(row.email);

  if (row.status === NOTION_UNSUBSCRIBED) {
    if (existing && (existing.status === 'subscribed' || existing.status === 'pending')) {
      const updated = await ctx.store.updateSubscriber(existing.id, {
        status: 'unsubscribed',
        unsubscribedAt: new Date(row.lastEditedTime).toISOString(),
      });
      await recordUnsubscribe(ctx, existing.email);
      if (updated) await enrollSubscriber(ctx, updated, { type: 'unsubscribe' });
      summary.unsubscribed += 1;
    }
    return;
  }
  if (row.status !== NOTION_SUBSCRIBED) return;

  const suppressedReason = await ctx.store.getSetting(
    `suppression:${createHash('sha256').update(row.email).digest('hex')}`,
  );

  if (existing) {
    if (existing.status === 'subscribed') return;
    const after = existing.unsubscribedAt ?? existing.createdAt;
    const genuinelyNewer = row.subscribedAt > after && row.subscribedAt >= since;
    if (!genuinelyNewer || existing.meta?.suppressedReason || suppressedReason === 'bounce' || suppressedReason === 'complaint') {
      summary.skippedConflict += 1;
      return;
    }
    // 退訂過或退信的人，Notion 上重新出現「訂閱中」也不直接加回：
    // 只有本人重新訂閱並點確認信才能解除退訂。這裡只計數，讓後台看得到。
    if (existing.status !== 'pending' || suppressedReason) {
      summary.needsConfirmation = (summary.needsConfirmation ?? 0) + 1;
      return;
    }
    const updated = await ctx.store.updateSubscriber(existing.id, {
      status: 'subscribed',
      unsubscribedAt: undefined,
      meta: withConsent(existing.meta, { method: 'notion', source: row.sources[0] ?? 'notion', at: row.subscribedAt }),
    });
    if (updated) await enrollSubscriber(ctx, updated, { type: 'subscribe' });
    summary.resubscribed += 1;
    return;
  }

  if (suppressedReason) {
    summary.skippedSuppressed += 1;
    return;
  }
  if (row.createdTime < since && row.subscribedAt < since) {
    summary.skippedOld += 1;
    return;
  }
  const tags = normalizeTags(row.sources.map(sourceTag));
  const subscriber: Subscriber = {
    id: notionSubscriberId(row.email),
    email: row.email,
    name: row.name,
    status: 'subscribed',
    tags,
    source: row.sources[0] ?? 'notion',
    createdAt: row.subscribedAt,
    // Notion 帶進來的人沒有點過這裡的確認信，不填 confirmedAt；同意來源記在 meta.consent。
    meta: withConsent({ importedFrom: 'notion' }, { method: 'notion', source: row.sources[0] ?? 'notion', at: row.subscribedAt }),
  };
  try {
    const created = await ctx.store.createSubscriber(subscriber);
    await enrollSubscriber(ctx, created, { type: 'subscribe' });
    if (tags.length > 0) await enrollSubscriber(ctx, created, { type: 'tag', tags });
    summary.added += 1;
  } catch (error) {
    // 另一個實例剛好先加了同一個人：不算錯
    if ((error as { status?: number }).status === 409) return;
    throw error;
  }
}

/** 這批列套用後，會有幾位目前訂閱中的人被退訂（同一信箱只算一次）。 */
async function countPendingUnsubscribes(ctx: ServiceContext, rows: NotionRow[]): Promise<number> {
  const emails = new Set<string>();
  for (const row of rows) {
    if (row.status !== NOTION_UNSUBSCRIBED || !EMAIL_PATTERN.test(row.email) || emails.has(row.email)) continue;
    const existing = await ctx.store.getSubscriberByEmail(row.email);
    if (existing && (existing.status === 'subscribed' || existing.status === 'pending')) emails.add(row.email);
  }
  return emails.size;
}

export async function getNotionInboundStatus(ctx: ServiceContext): Promise<NotionInboundStatus> {
  const raw = await ctx.store.getSetting(SETTING_KEY);
  let state: Partial<SyncState> = {};
  if (raw) {
    try {
      state = JSON.parse(raw) as Partial<SyncState>;
    } catch {
      state = {};
    }
  }
  return {
    enabled: isNotionInboundEnabled(),
    lastRunAt: state.lastRunAt ?? null,
    maxUnsubscribesPerRun: maxUnsubscribesPerRun(),
    held: state.held ?? null,
  };
}

/**
 * 後台確認暫停中的退訂：允許下一輪套用目前偵測到的數量，並立刻執行一次。
 * 如果確認之後 Notion 又多出更多退訂，會再次暫停等確認。
 */
export async function approveHeldUnsubscribes(
  ctx: ServiceContext,
  options: { fetchImpl?: FetchLike; now?: number } = {},
): Promise<NotionInboundSummary> {
  if (!readNotionEnv()) return emptySummary('notion_not_configured');
  if (!isNotionInboundEnabled()) return emptySummary('disabled');
  const raw = await ctx.store.getSetting(SETTING_KEY);
  const state = raw ? (JSON.parse(raw) as SyncState) : null;
  if (!state?.held) return emptySummary('nothing_held');
  await ctx.store.setSetting(SETTING_KEY, JSON.stringify({ ...state, approvedUnsubscribes: state.held.unsubscribes }));
  return maybeSyncFromNotion(ctx, { ...options, force: true });
}

/** 每 5 分鐘最多執行一次；失敗只記 log，不影響排程器其他工作。 */
export async function maybeSyncFromNotion(
  ctx: ServiceContext,
  options: { fetchImpl?: FetchLike; now?: number; force?: boolean } = {},
): Promise<NotionInboundSummary> {
  const env = readNotionEnv();
  if (!env) return emptySummary('notion_not_configured');
  if (!isNotionInboundEnabled()) return emptySummary('disabled');
  const now = options.now ?? Date.now();
  if (!options.force && now - lastAttemptAt < INTERVAL_MS) return emptySummary('throttled');
  lastAttemptAt = now;

  const fetchImpl = options.fetchImpl ?? fetch;
  const { state, fresh } = await readState(ctx, now);
  const summary = emptySummary();
  summary.ran = true;

  // 先把這一輪所有變動讀完，才能在動到名單之前判斷要不要暫停。
  const rows: NotionRow[] = [];
  let startCursor = state.pageCursor;
  let unfinishedPageCursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { results, hasMore, nextCursor } = await queryChanged(env, fetchImpl, state.cursor, startCursor);
    for (const raw of results) {
      const row = parseRow(raw);
      if (row) rows.push(row);
      else summary.invalid += 1;
    }
    if (!hasMore || !nextCursor) {
      unfinishedPageCursor = undefined;
      break;
    }
    startCursor = nextCursor;
    unfinishedPageCursor = nextCursor;
  }

  const pendingUnsubscribes = await countPendingUnsubscribes(ctx, rows);
  const limit = maxUnsubscribesPerRun();
  if (pendingUnsubscribes > limit && pendingUnsubscribes > (state.approvedUnsubscribes ?? 0)) {
    summary.held = true;
    summary.pendingUnsubscribes = pendingUnsubscribes;
    summary.reason = 'too_many_unsubscribes';
    // 游標不前進，這些列下一輪會再被讀到；同樣的暫停狀態不重複寫入。
    if (fresh || state.held?.unsubscribes !== pendingUnsubscribes) {
      const next: SyncState = {
        since: state.since,
        cursor: state.cursor,
        pageCursor: state.pageCursor,
        lastRunAt: nowIso(),
        held: { at: nowIso(), unsubscribes: pendingUnsubscribes },
      };
      await ctx.store.setSetting(SETTING_KEY, JSON.stringify(next));
    }
    logger.error('Notion 名單同步暫停：一次有太多訂閱者被改成已退訂，等後台確認', { pendingUnsubscribes, limit });
    return summary;
  }

  let latestEdited = state.cursor;
  for (const row of rows) {
    summary.checked += 1;
    await applyRow(ctx, row, state.since, summary);
    if (row.lastEditedTime > latestEdited) latestEdited = row.lastEditedTime;
  }

  // 還沒讀完：時間游標不動（分頁游標只對同一個查詢條件有效），下一輪從分頁游標接著讀。
  // 讀完了：結果依修改時間遞增排序，最後讀到的就是最新的修改時間。
  const cursor = unfinishedPageCursor ? state.cursor : latestEdited;
  const changedState =
    fresh ||
    cursor !== state.cursor ||
    unfinishedPageCursor !== state.pageCursor ||
    state.held !== undefined ||
    state.approvedUnsubscribes !== undefined;
  if (changedState) {
    const next: SyncState = { since: state.since, cursor, pageCursor: unfinishedPageCursor, lastRunAt: nowIso() };
    await ctx.store.setSetting(SETTING_KEY, JSON.stringify(next));
  }
  const changed = summary.added + summary.unsubscribed + summary.resubscribed;
  if (changed > 0 || summary.skippedConflict > 0) logger.info('Notion 名單同步完成', { ...summary });
  return summary;
}

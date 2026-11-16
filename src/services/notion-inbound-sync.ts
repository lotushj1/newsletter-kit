import { createHash } from 'node:crypto';
import { logger } from '../core/logger.js';
import { nowIso } from '../core/ids.js';
import { normalizeTags } from '../core/validate.js';
import type { Subscriber } from '../store/types.js';
import type { ServiceContext } from './context.js';
import { enrollSubscriber } from './enroll.js';
import { NOTION_SUBSCRIBED, NOTION_UNSUBSCRIBED, readNotionEnv, type NotionEnv } from './notion-sync.js';

/**
 * 從 Notion「電子報訂閱會員」資料庫把新訂閱與退訂拉回電子報系統。
 *
 * 官網（與 Portaly）的訂閱者會被同步進這個 Notion 資料庫，但不會直接進電子報系統；
 * 這個服務掛在排程器的 tick 裡（不受 SCHEDULER_ENABLED 影響，因為它不寄信），
 * 每 5 分鐘查一次「上次之後有被修改的列」。
 *
 * 保守規則：
 * - 只新增「同步開始之後才訂閱」的人；更早的列若不在名單內（例如刻意清除的舊會員）一律略過。
 * - Notion 已退訂 → 電子報系統跟著退訂（安全方向，一定照做）。
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

type FetchLike = typeof fetch;

interface SyncState {
  /** 只新增這個時間之後才訂閱的人。 */
  since: string;
  /** 下次查詢的起點（Notion last_edited_time，分鐘精度）。 */
  cursor: string;
  lastRunAt?: string | undefined;
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
  invalid: number;
  reason?: string | undefined;
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
    const updated = await ctx.store.updateSubscriber(existing.id, {
      status: 'subscribed',
      confirmedAt: row.subscribedAt,
      unsubscribedAt: undefined,
    });
    if (suppressedReason) await ctx.store.setSetting(`suppression:${createHash('sha256').update(row.email).digest('hex')}`, '');
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
    confirmedAt: row.subscribedAt,
    meta: { importedFrom: 'notion' },
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

  let cursor = state.cursor;
  let startCursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { results, hasMore, nextCursor } = await queryChanged(env, fetchImpl, state.cursor, startCursor);
    for (const raw of results) {
      const row = parseRow(raw);
      if (!row) {
        summary.invalid += 1;
        continue;
      }
      summary.checked += 1;
      await applyRow(ctx, row, state.since, summary);
      if (row.lastEditedTime > cursor) cursor = row.lastEditedTime;
    }
    if (!hasMore || !nextCursor) break;
    startCursor = nextCursor;
  }

  if (fresh || cursor !== state.cursor) {
    await ctx.store.setSetting(SETTING_KEY, JSON.stringify({ since: state.since, cursor, lastRunAt: nowIso() }));
  }
  const changed = summary.added + summary.unsubscribed + summary.resubscribed;
  if (changed > 0 || summary.skippedConflict > 0) logger.info('Notion 名單同步完成', { ...summary });
  return summary;
}

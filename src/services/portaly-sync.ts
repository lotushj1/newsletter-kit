import { DEFAULT_PORTALY_HOST } from '../email/adapters/portaly.js';
import { logger } from '../core/logger.js';
import { nowIso } from '../core/ids.js';
import type { ServiceContext } from './context.js';

/**
 * Portaly 目前沒有 webhook，投遞結果（退信、被檢舉、被抑制…）要用
 * GET /api/email/emails 定期回查。這個服務掛在排程器的 tick 裡，
 * 內部自己節流（預設每 10 分鐘跑一次、往回看 7 天——檢舉可能晚好幾天才進來）。
 */

const SETTING_KEY = 'portaly_delivery_sync';
/** 兩次回查至少間隔多久。 */
const SYNC_INTERVAL_MS = 10 * 60 * 1000;
/** 往回看幾天（檢舉與排程信的失敗可能很晚才出現）。 */
const LOOKBACK_DAYS = 7;
/** 讀取 API 的速率上限是每分鐘 120 次，每輪最多翻這麼多頁就夠了。 */
const MAX_PAGES = 10;
const PAGE_LIMIT = 100;

/** 只撈有問題的狀態；delivered 不用管。 */
const PROBLEM_STATUSES = 'bounced,complained,suppressed,failed,quota_exceeded,domain_limited';

type RecipientStatus =
  | 'bounced'
  | 'complained'
  | 'suppressed'
  | 'failed'
  | 'quota_exceeded'
  | 'domain_limited';

interface PortalyListItem {
  id?: string;
  recipients?: { status?: string }[];
}

interface PortalyListResponse {
  data?: PortalyListItem[];
  pagination?: { hasMore?: boolean; nextCursor?: string };
}

export interface PortalySyncSummary {
  ran: boolean;
  checked: number;
  updated: number;
}

const SKIPPED: PortalySyncSummary = { ran: false, checked: 0, updated: 0 };

const DELIVERY_ERRORS: Record<RecipientStatus, string> = {
  bounced: '硬退信：收件地址不存在（Portaly 回報）',
  complained: '收件人將信件標為垃圾信（Portaly 回報）',
  suppressed: 'Portaly 抑制名單內的地址，未寄出',
  failed: 'Portaly 回報寄送失敗',
  quota_exceeded: '排程寄出時 Portaly 額度不足',
  domain_limited: '排程寄出時寄信網域已達當日退信上限',
};

function isProblemStatus(value: string | undefined): value is RecipientStatus {
  return value !== undefined && PROBLEM_STATUSES.split(',').includes(value);
}

/** 單封信只有一位收件人，取第一個有問題的狀態即可。 */
function problemStatus(item: PortalyListItem): RecipientStatus | undefined {
  for (const recipient of item.recipients ?? []) {
    if (isProblemStatus(recipient.status)) return recipient.status;
  }
  return undefined;
}

async function applyProblem(
  ctx: ServiceContext,
  providerMessageId: string,
  status: RecipientStatus,
): Promise<boolean> {
  const delivery = await ctx.store.findDeliveryByProviderMessageId(providerMessageId);
  if (!delivery) return false;

  let changed = false;
  // complained 其實有送達，寄送紀錄保持 sent；其他一律改成 failed。
  if (status !== 'complained' && delivery.status !== 'failed') {
    await ctx.store.updateDelivery(delivery.id, { status: 'failed', error: DELIVERY_ERRORS[status] });
    changed = true;
  }

  const subscriber = await ctx.store.getSubscriber(delivery.subscriberId);
  if (subscriber && (subscriber.status === 'subscribed' || subscriber.status === 'pending')) {
    if (status === 'complained') {
      // 被檢舉的人視同退訂，之後任何寄送都會跳過。
      await ctx.store.updateSubscriber(subscriber.id, {
        status: 'unsubscribed',
        unsubscribedAt: nowIso(),
      });
      changed = true;
    } else if (status === 'bounced' || status === 'suppressed') {
      await ctx.store.updateSubscriber(subscriber.id, { status: 'bounced' });
      changed = true;
    }
  }
  return changed;
}

/** 立刻回查一次（排程器與測試用）。 */
export async function syncPortalyDeliveries(ctx: ServiceContext): Promise<PortalySyncSummary> {
  const email = ctx.config.email;
  if (email.provider !== 'portaly' || !email.portalyApiKey) return SKIPPED;

  const host = (email.portalyApiHost?.trim() || DEFAULT_PORTALY_HOST).replace(/\/+$/, '');
  const startDate = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

  let checked = 0;
  let updated = 0;
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const params = new URLSearchParams({
      recipientStatus: PROBLEM_STATUSES,
      startDate,
      limit: String(PAGE_LIMIT),
    });
    if (cursor) params.set('startAfter', cursor);

    let body: PortalyListResponse;
    try {
      const response = await fetch(`${host}/api/email/emails?${params.toString()}`, {
        headers: { authorization: `Bearer ${email.portalyApiKey}` },
      });
      if (!response.ok) {
        logger.warn('Portaly 投遞狀態回查失敗', { status: response.status });
        return { ran: true, checked, updated };
      }
      body = (await response.json()) as PortalyListResponse;
    } catch (error) {
      logger.warn('Portaly 投遞狀態回查失敗', { error: (error as Error).message });
      return { ran: true, checked, updated };
    }

    for (const item of body.data ?? []) {
      if (!item.id) continue;
      checked += 1;
      const status = problemStatus(item);
      if (!status) continue;
      if (await applyProblem(ctx, item.id, status)) updated += 1;
    }

    if (!body.pagination?.hasMore || !body.pagination.nextCursor) break;
    cursor = body.pagination.nextCursor;
  }

  await ctx.store.setSetting(SETTING_KEY, JSON.stringify({ lastRunAt: nowIso() }));
  return { ran: true, checked, updated };
}

/** 給排程器用：距離上次回查不到間隔時間就跳過。 */
export async function maybeSyncPortalyDeliveries(ctx: ServiceContext): Promise<PortalySyncSummary> {
  if (ctx.config.email.provider !== 'portaly' || !ctx.config.email.portalyApiKey) return SKIPPED;
  const raw = await ctx.store.getSetting(SETTING_KEY);
  if (raw) {
    try {
      const { lastRunAt } = JSON.parse(raw) as { lastRunAt?: string };
      if (lastRunAt && Date.now() - Date.parse(lastRunAt) < SYNC_INTERVAL_MS) return SKIPPED;
    } catch {
      // 壞掉的紀錄直接重跑
    }
  }
  return syncPortalyDeliveries(ctx);
}

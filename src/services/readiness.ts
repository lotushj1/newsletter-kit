import { nowIso } from '../core/ids.js';
import type { ServiceContext } from './context.js';
import { EMPTY_SCHEDULER_STATE, readSchedulerState, type SchedulerState } from './scheduler-state.js';
import { isSendingNow } from './send-state.js';
import { sendingBlockedReason } from './sending.js';
import { checkStoreReadiness, type StoreReadiness } from './store-readiness.js';

/** 上次成功跑完 tick 超過這麼久就提醒（外部 cron 每 1～5 分鐘打一次）。 */
export const TICK_STALE_MS = 15 * 60 * 1000;
/** 排程時間已過這麼久還沒開始寄就提醒。 */
export const SCHEDULE_OVERDUE_MS = 15 * 60 * 1000;
/** 「寄送中」沒有進度、或寄送紀錄停在結果未確認超過這麼久就提醒。 */
export const SENDING_STUCK_MS = 30 * 60 * 1000;
/** 寄送暫停（SEND_PAUSED、排程關閉）超過這麼久就提醒，避免忘了打開。 */
export const PAUSED_LONG_MS = 24 * 60 * 60 * 1000;
/** 掃描結果未確認的寄送紀錄時，只看最近這麼多封電子報。 */
const RECENT_CAMPAIGNS = 50;

export interface ReadinessAlert {
  code:
    | 'store_unavailable'
    | 'scheduler_never_ran'
    | 'scheduler_stale'
    | 'scheduled_overdue'
    | 'sending_stalled'
    | 'deliveries_unconfirmed'
    | 'send_paused_long'
    | 'scheduler_disabled_long';
  message: string;
}

export interface ReadinessReport {
  /** ready 且沒有任何提醒；uptime 監控看這個（/api/cron/readiness 不是 true 就回 503）。 */
  ok: boolean;
  /** 資料庫可讀寫、schema 正確，可以受理訂閱與寄送。 */
  ready: boolean;
  checkedAt: string;
  store: StoreReadiness;
  sending: {
    provider: string;
    /** dry_run 只寫紀錄、不會真的寄出。 */
    dryRun: boolean;
    /** SEND_PAUSED=true：全面寄送暫停（手動、排程、序列信都不寄）。 */
    paused: boolean;
    pausedSince: string | null;
    /** SCHEDULER_ENABLED=false：排程寄送暫停（排程電子報與序列信不會自動寄，手動寄送照常）。 */
    schedulerEnabled: boolean;
    schedulerDisabledSince: string | null;
    autoResume: boolean;
    blockedReason: string | null;
  };
  /** 投遞回執（退信、檢舉）對帳：兩種暫停都不會停掉它。 */
  receipts: {
    mode: 'portaly_sync' | 'webhook' | 'none';
    /** Portaly 回查最後一次跑的時間；其他模式為 null。 */
    lastRunAt: string | null;
  };
  scheduler: SchedulerState & { lastSuccessAgeMs: number | null };
  backlog: {
    /** 排程時間已到、還沒開始寄的電子報。 */
    dueCampaigns: number;
    overdueCampaigns: number;
    /** 狀態是「寄送中」的電子報。 */
    sendingCampaigns: number;
    /** 「寄送中」但超過門檻沒有進度、這個程序也沒在寄的。 */
    stalledCampaigns: number;
    /** 最近電子報裡，停在「已交給寄信服務、結果未確認」的寄送紀錄。 */
    unconfirmedDeliveries: number;
    /** 其中超過門檻還沒確認的。 */
    stuckDeliveries: number;
    oldestUnconfirmedAt: string | null;
  };
  thresholds: { tickStaleMs: number; scheduleOverdueMs: number; sendingStuckMs: number; pausedLongMs: number };
  alerts: ReadinessAlert[];
}

const minutes = (ms: number): number => Math.max(1, Math.round(ms / 60_000));

function age(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? now - at : null;
}

async function portalyLastRun(ctx: ServiceContext): Promise<string | null> {
  const raw = await ctx.store.getSetting('portaly_delivery_sync');
  if (!raw) return null;
  try {
    return (JSON.parse(raw) as { lastRunAt?: string }).lastRunAt ?? null;
  } catch {
    return null;
  }
}

async function collectBacklog(ctx: ServiceContext, now: number): Promise<ReadinessReport['backlog']> {
  const due = await ctx.store.findDueCampaigns(new Date(now).toISOString());
  const sending = await ctx.store.findSendingCampaigns();
  const recent = await ctx.store.listCampaigns({ limit: RECENT_CAMPAIGNS });
  let unconfirmedDeliveries = 0;
  let stuckDeliveries = 0;
  let oldest: number | null = null;
  for (const campaign of recent.items) {
    if (!campaign.stats.unconfirmed) continue;
    unconfirmedDeliveries += campaign.stats.unconfirmed;
    for (const delivery of await ctx.store.listDeliveries(campaign.id, { status: 'sending', limit: 1000 })) {
      const claimed = delivery.claimedAt ? Date.parse(delivery.claimedAt) : NaN;
      if (!Number.isFinite(claimed)) continue;
      oldest = oldest === null ? claimed : Math.min(oldest, claimed);
      if (now - claimed > SENDING_STUCK_MS) stuckDeliveries += 1;
    }
  }
  return {
    dueCampaigns: due.length,
    overdueCampaigns: due.filter((c) => (age(c.scheduledAt, now) ?? 0) > SCHEDULE_OVERDUE_MS).length,
    sendingCampaigns: sending.length,
    stalledCampaigns: sending.filter((c) => !isSendingNow(c.id) && (age(c.updatedAt, now) ?? 0) > SENDING_STUCK_MS).length,
    unconfirmedDeliveries,
    stuckDeliveries,
    oldestUnconfirmedAt: oldest === null ? null : new Date(oldest).toISOString(),
  };
}

/**
 * 給操作者的運作狀態：資料庫能不能寫、schema 對不對、兩種暫停、排程最後一次 tick 與待辦量。
 * 會做一次寫入探測（見 store-readiness），所以只放在需要登入或 CRON_SECRET 的端點。
 */
export async function readinessReport(ctx: ServiceContext, now = Date.now()): Promise<ReadinessReport> {
  const store = await checkStoreReadiness(ctx, { full: true });
  const alerts: ReadinessAlert[] = [];
  if (!store.ok) {
    alerts.push({ code: 'store_unavailable', message: `資料庫無法正常讀寫，新的訂閱與寄送都已暫停：${store.problems.join('；')}` });
  }

  // 資料庫讀不到時下面這些會失敗：留空，只回報上面的資料庫問題。
  let scheduler: SchedulerState | null = null;
  let backlog: ReadinessReport['backlog'] | null = null;
  let lastRunAt: string | null = null;
  const portaly = ctx.config.email.provider === 'portaly' && Boolean(ctx.config.email.portalyApiKey);
  try {
    scheduler = await readSchedulerState(ctx);
    backlog = await collectBacklog(ctx, now);
    if (portaly) lastRunAt = await portalyLastRun(ctx);
  } catch (error) {
    if (store.ok) {
      alerts.push({ code: 'store_unavailable', message: `讀取排程與寄送狀態失敗：${(error as Error).message}` });
    }
  }
  const state = scheduler ?? EMPTY_SCHEDULER_STATE;
  const lastSuccessAgeMs = age(state.lastCompletedAt, now);
  const { paused = false, autoResume = false } = ctx.config.send;
  const schedulerEnabled = ctx.config.scheduler.enabled;

  if (schedulerEnabled && scheduler) {
    if (lastSuccessAgeMs === null) {
      alerts.push({
        code: 'scheduler_never_ran',
        message: '還沒有成功跑完的排程 tick。確認外部 cron（Cloudflare Worker、GitHub Actions）有帶 CRON_SECRET 打 /api/cron/tick。',
      });
    } else if (lastSuccessAgeMs > TICK_STALE_MS) {
      alerts.push({
        code: 'scheduler_stale',
        message: `排程上次成功跑完是 ${minutes(lastSuccessAgeMs)} 分鐘前（超過 ${minutes(TICK_STALE_MS)} 分鐘），排程電子報可能沒有準時寄出。`,
      });
    }
  }
  if (backlog?.overdueCampaigns) {
    alerts.push({
      code: 'scheduled_overdue',
      message: `有 ${backlog.overdueCampaigns} 封排程電子報已超過預定時間 ${minutes(SCHEDULE_OVERDUE_MS)} 分鐘還沒開始寄。`,
    });
  }
  if (backlog?.stalledCampaigns) {
    alerts.push({
      code: 'sending_stalled',
      message: `有 ${backlog.stalledCampaigns} 封電子報停在「寄送中」超過 ${minutes(SENDING_STUCK_MS)} 分鐘沒有進度，請到電子報頁確認是否要繼續寄送。`,
    });
  }
  if (backlog?.stuckDeliveries) {
    alerts.push({
      code: 'deliveries_unconfirmed',
      message: `有 ${backlog.stuckDeliveries} 筆寄送紀錄已交給寄信服務超過 ${minutes(SENDING_STUCK_MS)} 分鐘仍未確認結果，請向寄信服務對帳。`,
    });
  }
  const pausedAge = paused ? age(state.sendPausedSince, now) : null;
  if (pausedAge !== null && pausedAge > PAUSED_LONG_MS) {
    alerts.push({ code: 'send_paused_long', message: `全面寄送暫停（SEND_PAUSED=true）已超過 ${Math.floor(pausedAge / 3_600_000)} 小時。` });
  }
  const disabledAge = schedulerEnabled ? null : age(state.schedulerDisabledSince, now);
  if (disabledAge !== null && disabledAge > PAUSED_LONG_MS) {
    alerts.push({
      code: 'scheduler_disabled_long',
      message: `排程寄送暫停（SCHEDULER_ENABLED=false）已超過 ${Math.floor(disabledAge / 3_600_000)} 小時，排程電子報與序列信都不會自動寄出。`,
    });
  }

  return {
    ok: store.ok && alerts.length === 0,
    ready: store.ok,
    checkedAt: nowIso(),
    store,
    sending: {
      provider: ctx.adapter.name,
      dryRun: ctx.adapter.name === 'dry_run',
      paused,
      pausedSince: paused ? state.sendPausedSince : null,
      schedulerEnabled,
      schedulerDisabledSince: schedulerEnabled ? null : state.schedulerDisabledSince,
      autoResume,
      blockedReason: sendingBlockedReason(ctx),
    },
    receipts: {
      mode: portaly ? 'portaly_sync' : ctx.adapter.name === 'dry_run' ? 'none' : 'webhook',
      lastRunAt,
    },
    scheduler: { ...state, lastSuccessAgeMs },
    backlog: backlog ?? {
      dueCampaigns: 0,
      overdueCampaigns: 0,
      sendingCampaigns: 0,
      stalledCampaigns: 0,
      unconfirmedDeliveries: 0,
      stuckDeliveries: 0,
      oldestUnconfirmedAt: null,
    },
    thresholds: {
      tickStaleMs: TICK_STALE_MS,
      scheduleOverdueMs: SCHEDULE_OVERDUE_MS,
      sendingStuckMs: SENDING_STUCK_MS,
      pausedLongMs: PAUSED_LONG_MS,
    },
    alerts,
  };
}

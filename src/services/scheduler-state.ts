import { nowIso } from '../core/ids.js';
import type { ServiceContext } from './context.js';
import type { TickSummary } from './scheduler.js';

/**
 * 排程器每次 tick 的紀錄，存在 settings（serverless 每次請求可能是新實例，記憶體留不住）。
 * 後台「運作狀態」與 /api/cron/readiness 讀這份判斷排程有沒有在跑、是否落後。
 */
export const SCHEDULER_STATE_KEY = 'scheduler_state';

export interface SchedulerState {
  /** 最近一次 tick 開始的時間（不論有沒有跑完）。 */
  lastStartedAt: string | null;
  /** 最近一次 tick 結束的時間（成功或失敗）。 */
  lastFinishedAt: string | null;
  /** 最近一次「成功跑完」的時間。 */
  lastCompletedAt: string | null;
  lastDurationMs: number | null;
  /** 這次 tick 開始寄的排程電子報，比預定時間晚了多久（取最大值；沒有就是 0）。 */
  lastLagMs: number | null;
  /** 距離上一次 tick 開始隔了多久。 */
  lastIntervalMs: number | null;
  lastError: string | null;
  lastSkippedReason: string | null;
  /** tick 結束時還沒處理完的量。 */
  backlog: { dueCampaigns: number; sendingCampaigns: number } | null;
  /** SEND_PAUSED=true 從哪一次 tick 開始被看到；解除後清空。 */
  sendPausedSince: string | null;
  /** SCHEDULER_ENABLED=false 從哪一次 tick 開始被看到；開啟後清空。 */
  schedulerDisabledSince: string | null;
}

export const EMPTY_SCHEDULER_STATE: SchedulerState = {
  lastStartedAt: null,
  lastFinishedAt: null,
  lastCompletedAt: null,
  lastDurationMs: null,
  lastLagMs: null,
  lastIntervalMs: null,
  lastError: null,
  lastSkippedReason: null,
  backlog: null,
  sendPausedSince: null,
  schedulerDisabledSince: null,
};

export async function readSchedulerState(ctx: ServiceContext): Promise<SchedulerState> {
  const raw = await ctx.store.getSetting(SCHEDULER_STATE_KEY);
  if (!raw) return { ...EMPTY_SCHEDULER_STATE };
  try {
    return { ...EMPTY_SCHEDULER_STATE, ...(JSON.parse(raw) as Partial<SchedulerState>) };
  } catch {
    return { ...EMPTY_SCHEDULER_STATE };
  }
}

/**
 * tick 開始：記下開始時間，回傳上一份紀錄（算間隔用）。
 * 整份快照的 store（insforge）每寫一次都要重寫整份資料，開始時不另外寫，只在結束時寫一次。
 */
export async function recordTickStart(ctx: ServiceContext, startedAt: string): Promise<SchedulerState> {
  const previous = await readSchedulerState(ctx);
  if (ctx.store.driver !== 'insforge') {
    await ctx.store.setSetting(SCHEDULER_STATE_KEY, JSON.stringify({ ...previous, lastStartedAt: startedAt }));
  }
  return previous;
}

/** tick 結束：記下結果、耗時、落後時間與剩下的待辦。 */
export async function recordTickEnd(
  ctx: ServiceContext,
  input: { previous: SchedulerState; startedAt: number; lagMs: number; summary: TickSummary },
): Promise<SchedulerState> {
  const finishedAt = Date.now();
  const started = new Date(input.startedAt).toISOString();
  let backlog: SchedulerState['backlog'] = null;
  try {
    backlog = {
      dueCampaigns: (await ctx.store.findDueCampaigns(nowIso())).length,
      sendingCampaigns: (await ctx.store.findSendingCampaigns()).length,
    };
  } catch {
    // 讀不到就留空，不影響 tick 本身的結果。
  }
  const previous = input.previous;
  const previousStart = previous.lastStartedAt ? Date.parse(previous.lastStartedAt) : NaN;
  const state: SchedulerState = {
    ...previous,
    lastStartedAt: started,
    lastFinishedAt: new Date(finishedAt).toISOString(),
    lastCompletedAt: input.summary.error ? previous.lastCompletedAt : new Date(finishedAt).toISOString(),
    lastDurationMs: finishedAt - input.startedAt,
    lastLagMs: input.lagMs,
    lastIntervalMs: Number.isFinite(previousStart) ? input.startedAt - previousStart : null,
    lastError: input.summary.error ?? null,
    lastSkippedReason: input.summary.skippedReason ?? null,
    backlog,
    sendPausedSince: ctx.config.send.paused ? (previous.sendPausedSince ?? started) : null,
    schedulerDisabledSince: ctx.config.scheduler.enabled ? null : (previous.schedulerDisabledSince ?? started),
  };
  await ctx.store.setSetting(SCHEDULER_STATE_KEY, JSON.stringify(state));
  return state;
}

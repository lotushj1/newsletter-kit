import { logger } from '../core/logger.js';
import { nowIso } from '../core/ids.js';
import type { ServiceContext } from './context.js';
import { maybeSyncPortalyDeliveries } from './portaly-sync.js';
import { processDueEnrollments } from './sequences.js';
import { isSending, processCampaign, sendingBlockedReason, startCampaign } from './sending.js';

export interface TickSummary {
  resumed: number;
  started: number;
  sequenced: number;
  /** scheduler_disabled：SCHEDULER_ENABLED=false，只做投遞狀態回查，不寄任何信。 */
  skippedReason?: 'scheduler_disabled' | 'sending_blocked' | 'already_running' | undefined;
  error?: string | undefined;
}

export interface Scheduler {
  start(): void;
  stop(): void;
  /** 手動跑一次，測試或外部 cron 可以直接呼叫。 */
  tick(): Promise<TickSummary>;
}

/**
 * 單一程序的輪詢排程器。多台機器同時跑會重複寄，
 * 那種情境請只開一台 SCHEDULER_ENABLED=true，或改接外部 cron 打 tick。
 */
export function createScheduler(ctx: ServiceContext): Scheduler {
  let timer: NodeJS.Timeout | undefined;
  let running = false;

  async function tick(): Promise<TickSummary> {
    const summary: TickSummary = { resumed: 0, started: 0, sequenced: 0, skippedReason: undefined };
    if (running) return { ...summary, skippedReason: 'already_running' };
    running = true;
    try {
      const blocked = sendingBlockedReason(ctx);
      // 外部 cron（Cloudflare Worker、GitHub Actions）也會打進來，所以開關一定要在這裡判斷，
      // 不能只靠「沒有啟動 setInterval」。後台顯示「自動排程關閉」時就真的不會寄。
      if (!ctx.config.scheduler.enabled) {
        summary.skippedReason = 'scheduler_disabled';
      } else if (blocked) {
        summary.skippedReason = 'sending_blocked';
        logger.warn('排程器跳過寄送', { reason: blocked });
      } else {
        // 「寄送中」預設不自動續寄：部署、重啟、還原資料後都要人工在後台確認再續寄。
        if (ctx.config.send.autoResume) {
          for (const campaign of await ctx.store.findSendingCampaigns()) {
            if (isSending(campaign.id)) continue;
            logger.info('接續未完成的寄送', { campaignId: campaign.id });
            await processCampaign(ctx, campaign.id);
            summary.resumed += 1;
          }
        }
        for (const campaign of await ctx.store.findDueCampaigns(nowIso())) {
          logger.info('排程時間到，開始寄送', { campaignId: campaign.id, slug: campaign.slug });
          await startCampaign(ctx, campaign.id);
          summary.started += 1;
        }
        summary.sequenced = await processDueEnrollments(ctx);
        if (summary.sequenced > 0) logger.info('序列信已寄出', { count: summary.sequenced });
      }
      // Portaly 沒有 webhook，退信／檢舉靠定期回查（服務內部自己節流）。
      const portaly = await maybeSyncPortalyDeliveries(ctx);
      if (portaly.updated > 0) {
        logger.info('Portaly 投遞狀態已同步', { checked: portaly.checked, updated: portaly.updated });
      }
    } catch (error) {
      logger.error('排程器執行失敗', { error: (error as Error).message });
      summary.error = (error as Error).message;
    } finally {
      running = false;
    }
    return summary;
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => void tick(), ctx.config.scheduler.pollMs);
      timer.unref?.();
      void tick();
      logger.info('排程器已啟動', { pollMs: ctx.config.scheduler.pollMs });
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    tick,
  };
}

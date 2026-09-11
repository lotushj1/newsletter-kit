import { logger } from '../core/logger.js';
import { nowIso } from '../core/ids.js';
import type { ServiceContext } from './context.js';
import { isSending, processCampaign, startCampaign } from './sending.js';

export interface Scheduler {
  start(): void;
  stop(): void;
  /** 手動跑一次，測試或外部 cron 可以直接呼叫。 */
  tick(): Promise<void>;
}

/**
 * 單一程序的輪詢排程器。多台機器同時跑會重複寄，
 * 那種情境請只開一台 SCHEDULER_ENABLED=true，或改接外部 cron 打 tick。
 */
export function createScheduler(ctx: ServiceContext): Scheduler {
  let timer: NodeJS.Timeout | undefined;
  let running = false;

  async function tick(): Promise<void> {
    if (running) return;
    running = true;
    try {
      // 重啟後把卡在 sending 的續完。
      for (const campaign of await ctx.store.findSendingCampaigns()) {
        if (isSending(campaign.id)) continue;
        logger.info('接續未完成的寄送', { campaignId: campaign.id });
        await processCampaign(ctx, campaign.id);
      }
      for (const campaign of await ctx.store.findDueCampaigns(nowIso())) {
        logger.info('排程時間到，開始寄送', { campaignId: campaign.id, slug: campaign.slug });
        await startCampaign(ctx, campaign.id);
      }
    } catch (error) {
      logger.error('排程器執行失敗', { error: (error as Error).message });
    } finally {
      running = false;
    }
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

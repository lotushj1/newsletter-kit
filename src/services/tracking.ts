import { newId, nowIso } from '../core/ids.js';
import { logger } from '../core/logger.js';
import { verifyToken } from '../core/tokens.js';
import { normalizeTrackedUrl } from '../core/tracking.js';
import type { ServiceContext } from './context.js';
import { enrollSubscriber } from './enroll.js';

export async function recordOpen(
  ctx: ServiceContext,
  token: string,
): Promise<boolean> {
  const verified = verifyToken(ctx.config.appSecret, token, 'open');
  if (!verified?.campaignId) return false;
  const campaignId = verified.campaignId;
  // 資料層暫時寫不進去時只記警告：追蹤圖照樣回傳，不讓讀者看到錯誤。
  await recordSafely('open', campaignId, async () => {
    await ctx.store.createEvent({
      id: newId('evt'),
      campaignId,
      subscriberId: verified.subscriberId,
      deliveryId: verified.deliveryId,
      type: 'open',
      createdAt: nowIso(),
    });
    if (verified.subscriberId) {
      const subscriber = await ctx.store.getSubscriber(verified.subscriberId);
      if (subscriber) {
        await enrollSubscriber(ctx, subscriber, { type: 'open', campaignId });
      }
    }
  });
  return true;
}

export async function recordClick(
  ctx: ServiceContext,
  token: string,
): Promise<string | null> {
  const verified = verifyToken(ctx.config.appSecret, token, 'click');
  if (!verified?.campaignId || !verified.url) return null;
  const campaignId = verified.campaignId;
  const url = normalizeTrackedUrl(verified.url);
  // 記錄失敗也照樣轉址：讀者點連結一定要到得了目的地。
  await recordSafely('click', campaignId, async () => {
    await ctx.store.createEvent({
      id: newId('evt'),
      campaignId,
      subscriberId: verified.subscriberId,
      deliveryId: verified.deliveryId,
      type: 'click',
      url,
      createdAt: nowIso(),
    });
    if (verified.subscriberId) {
      const subscriber = await ctx.store.getSubscriber(verified.subscriberId);
      if (subscriber) {
        await enrollSubscriber(ctx, subscriber, { type: 'click', campaignId });
      }
    }
  });
  return url;
}

async function recordSafely(type: 'open' | 'click', campaignId: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    logger.warn('追蹤事件寫入失敗，這筆不計入統計', { type, campaignId, error: (error as Error).message });
  }
}

import { createHash } from 'node:crypto';
import { nowIso } from '../core/ids.js';
import { syncSubscriberToNotion } from './notion-sync.js';
import type { ServiceContext } from './context.js';

export type SuppressionReason = 'bounce' | 'complaint';

/** 名單裡找不到的地址按了退訂（例如資料遺失期間）：先記下來，還原或匯入名單後也不會寄給他。 */
const UNSUBSCRIBE_MARK = 'unsubscribe';

function key(email: string): string {
  return `suppression:${createHash('sha256').update(email.trim().toLowerCase()).digest('hex')}`;
}

export async function isSuppressed(ctx: ServiceContext, email: string): Promise<boolean> {
  return Boolean(await ctx.store.getSetting(key(email)));
}

/** Shared by provider webhooks and Portaly polling. A complaint always wins over a bounce. */
export async function applyProviderProblem(
  ctx: ServiceContext,
  input: { email?: string; providerMessageId?: string; reason: SuppressionReason; provider: string },
): Promise<boolean> {
  const delivery = input.providerMessageId ? await ctx.store.findDeliveryByProviderMessageId(input.providerMessageId) : null;
  const email = (input.email || delivery?.email || '').trim().toLowerCase();
  if (!email) return false;
  const settingKey = key(email);
  const current = await ctx.store.getSetting(settingKey);
  const reason = current === 'complaint' ? 'complaint' : input.reason;
  if (current !== reason) await ctx.store.setSetting(settingKey, reason);
  const subscriber = await ctx.store.getSubscriberByEmail(email);
  let changed = current !== reason;
  if (subscriber) {
    const status = reason === 'complaint' ? 'unsubscribed' : subscriber.status === 'unsubscribed' ? 'unsubscribed' : 'bounced';
    if (subscriber.status !== status || subscriber.meta?.suppressedReason !== reason) {
      await ctx.store.updateSubscriber(subscriber.id, {
        status,
        unsubscribedAt: status === 'unsubscribed' ? subscriber.unsubscribedAt ?? nowIso() : subscriber.unsubscribedAt,
        meta: { ...subscriber.meta, suppressedReason: reason, suppressedBy: input.provider },
      });
      if (subscriber.status !== status) syncSubscriberToNotion(email, status);
      changed = true;
    }
  }
  if (delivery && reason === 'bounce' && delivery.status !== 'failed') {
    await ctx.store.updateDelivery(delivery.id, { status: 'failed', error: `硬退信（${input.provider}）` });
    changed = true;
  }
  return changed;
}

/**
 * 退訂了但名單裡沒有這個人（2026-11-04 資料被清空後就發生過，當時退訂完全沒有留下紀錄）。
 * 記進排除名單；之後即使從備份還原或重新匯入，寄送時也會因為 isSuppressed 而跳過。
 */
export async function recordUnsubscribeWithoutSubscriber(ctx: ServiceContext, email: string): Promise<void> {
  const settingKey = key(email);
  const current = await ctx.store.getSetting(settingKey);
  if (current) return; // 已有退信／檢舉／退訂紀錄
  await ctx.store.setSetting(settingKey, UNSUBSCRIBE_MARK);
}

/** 本人重新訂閱並完成確認時，解除「退訂」這種排除（退信、檢舉不解除）。 */
export async function clearUnsubscribeSuppression(ctx: ServiceContext, email: string): Promise<void> {
  const settingKey = key(email);
  if ((await ctx.store.getSetting(settingKey)) === UNSUBSCRIBE_MARK) {
    await ctx.store.setSetting(settingKey, '');
  }
}

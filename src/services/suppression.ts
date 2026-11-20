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

/** 整批查排除名單，回傳被排除的地址（小寫）。名單很長時不用每個人各打一次資料庫。 */
export async function suppressedEmails(ctx: ServiceContext, emails: string[]): Promise<Set<string>> {
  const byKey = new Map(emails.map((email) => [key(email), email.trim().toLowerCase()]));
  if (byKey.size === 0) return new Set();
  const found = await ctx.store.getSettings([...byKey.keys()]);
  return new Set(Object.entries(found).filter(([, value]) => Boolean(value)).map(([k]) => byKey.get(k)!));
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

export type SuppressionMark = SuppressionReason | typeof UNSUBSCRIBE_MARK;

/** 這個地址在排除名單裡的原因；沒有被排除就回傳 null。 */
export async function suppressionReasonFor(ctx: ServiceContext, email: string): Promise<SuppressionMark | null> {
  const value = await ctx.store.getSetting(key(email));
  return value === 'bounce' || value === 'complaint' || value === UNSUBSCRIBE_MARK ? value : null;
}

/** 被排除的地址重新出現在名單上（匯入、簽名匯入）時該用的狀態：退信算 bounced，其餘算 unsubscribed。 */
export function statusForSuppression(reason: SuppressionMark): 'bounced' | 'unsubscribed' {
  return reason === 'bounce' ? 'bounced' : 'unsubscribed';
}

/**
 * 退訂一律記進排除名單，不只改訂閱者狀態。
 * 2026-11-04 資料被清空時，名單裡找不到的人按退訂完全沒有留下紀錄；
 * 名單裡的人退訂後被刪除再重新匯入，也會變回已訂閱。
 * 記下來之後，即使從備份還原、重新匯入或刪除後再加回，寄送時也會因為 isSuppressed 而跳過；
 * 只有本人重新訂閱並完成確認才會解除（clearUnsubscribeSuppression）。
 */
export async function recordUnsubscribe(ctx: ServiceContext, email: string): Promise<void> {
  const settingKey = key(email);
  const current = await ctx.store.getSetting(settingKey);
  if (current) return; // 已有退信／檢舉／退訂紀錄
  await ctx.store.setSetting(settingKey, UNSUBSCRIBE_MARK);
}

/** 後台把人標成退信、或刪除一位退信者時，留下退信紀錄（已有檢舉紀錄就不覆蓋）。 */
export async function recordBounce(ctx: ServiceContext, email: string): Promise<void> {
  const settingKey = key(email);
  const current = await ctx.store.getSetting(settingKey);
  if (current === 'bounce' || current === 'complaint') return;
  await ctx.store.setSetting(settingKey, 'bounce');
}

/** 本人重新訂閱並完成確認時，解除「退訂」這種排除（退信、檢舉不解除）。 */
export async function clearUnsubscribeSuppression(ctx: ServiceContext, email: string): Promise<void> {
  const settingKey = key(email);
  if ((await ctx.store.getSetting(settingKey)) === UNSUBSCRIBE_MARK) {
    await ctx.store.setSetting(settingKey, '');
  }
}

import { createHash } from 'node:crypto';
import { nowIso } from '../core/ids.js';
import type { ServiceContext } from './context.js';

export type SuppressionReason = 'bounce' | 'complaint';

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
      changed = true;
    }
  }
  if (delivery && reason === 'bounce' && delivery.status !== 'failed') {
    await ctx.store.updateDelivery(delivery.id, { status: 'failed', error: `硬退信（${input.provider}）` });
    changed = true;
  }
  return changed;
}

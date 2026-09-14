import { newId, nowIso } from '../core/ids.js';
import { verifyToken } from '../core/tokens.js';
import type { ServiceContext } from './context.js';
import { enrollSubscriber } from './enroll.js';

export async function recordOpen(
  ctx: ServiceContext,
  token: string,
): Promise<boolean> {
  const verified = verifyToken(ctx.config.appSecret, token, 'open');
  if (!verified?.campaignId) return false;
  await ctx.store.createEvent({
    id: newId('evt'),
    campaignId: verified.campaignId,
    subscriberId: verified.subscriberId,
    deliveryId: verified.deliveryId,
    type: 'open',
    createdAt: nowIso(),
  });
  if (verified.subscriberId) {
    const subscriber = await ctx.store.getSubscriber(verified.subscriberId);
    if (subscriber) {
      await enrollSubscriber(ctx, subscriber, { type: 'open', campaignId: verified.campaignId });
    }
  }
  return true;
}

export async function recordClick(
  ctx: ServiceContext,
  token: string,
): Promise<string | null> {
  const verified = verifyToken(ctx.config.appSecret, token, 'click');
  if (!verified?.campaignId || !verified.url) return null;
  await ctx.store.createEvent({
    id: newId('evt'),
    campaignId: verified.campaignId,
    subscriberId: verified.subscriberId,
    deliveryId: verified.deliveryId,
    type: 'click',
    url: verified.url,
    createdAt: nowIso(),
  });
  if (verified.subscriberId) {
    const subscriber = await ctx.store.getSubscriber(verified.subscriberId);
    if (subscriber) {
      await enrollSubscriber(ctx, subscriber, { type: 'click', campaignId: verified.campaignId });
    }
  }
  return verified.url;
}

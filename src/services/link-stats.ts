import { normalizeTrackedUrl } from '../core/tracking.js';
import type { ServiceContext } from './context.js';

export async function campaignLinkStats(ctx: ServiceContext, campaignId: string) {
  const events = await ctx.store.listTrackingEvents({ campaignId, type: 'click' });
  const counts = new Map<string, { url: string; clicks: number; subscribers: Set<string> }>();
  for (const event of events) {
    if (!event.url) continue;
    const url = normalizeTrackedUrl(event.url);
    const row = counts.get(url) ?? { url, clicks: 0, subscribers: new Set<string>() };
    row.clicks += 1;
    row.subscribers.add(event.subscriberId ?? event.deliveryId ?? event.id);
    counts.set(url, row);
  }
  return [...counts.values()].map(({ url, clicks, subscribers }) => ({ url, clicks, uniqueClicks: subscribers.size }))
    .sort((a, b) => b.clicks - a.clicks || a.url.localeCompare(b.url));
}

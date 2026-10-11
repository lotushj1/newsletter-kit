import { badRequest } from '../core/errors.js';
import { normalizeTrackedUrl } from '../core/tracking.js';
import type { AudienceCondition, Campaign, Subscriber, TrackingEvent } from '../store/types.js';
import { audienceFromCampaign } from '../store/types.js';
import type { ServiceContext } from './context.js';
import { isSuppressed } from './suppression.js';

export function parseAudienceCondition(value: unknown, depth = 0, budget = { remaining: 100 }): AudienceCondition | undefined {
  if (value === undefined || value === null) return undefined;
  budget.remaining -= 1;
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 8 || budget.remaining < 0) throw badRequest('受眾條件格式不正確');
  const row = value as Record<string, unknown>;
  if (row.op === 'and' || row.op === 'or') {
    if (!Array.isArray(row.children) || row.children.length > 20) throw badRequest('受眾群組需要條件（最多 20 個）');
    return { op: row.op, children: row.children.map((child) => {
      const parsed = parseAudienceCondition(child, depth + 1, budget);
      if (!parsed) throw badRequest('受眾條件不能為空');
      return parsed;
    }) };
  }
  if (row.op === 'not') {
    const child = parseAudienceCondition(row.child, depth + 1, budget);
    if (!child) throw badRequest('排除條件不能為空');
    return { op: 'not', child };
  }
  if (row.op === 'tag' && typeof row.tag === 'string' && row.tag.trim()) return { op: 'tag', tag: row.tag.trim().toLowerCase() };
  if (row.op === 'folder' && typeof row.folderId === 'string' && row.folderId) return { op: 'folder', folderId: row.folderId };
  if (row.op === 'status' && ['subscribed', 'pending', 'unsubscribed', 'bounced'].includes(String(row.status))) return { op: 'status', status: row.status as Subscriber['status'] };
  if (row.op === 'created') {
    const after = typeof row.after === 'string' && !Number.isNaN(Date.parse(row.after)) ? /^\d{4}-\d{2}-\d{2}$/.test(row.after) ? `${row.after}T00:00:00.000Z` : row.after : undefined;
    const before = typeof row.before === 'string' && !Number.isNaN(Date.parse(row.before)) ? /^\d{4}-\d{2}-\d{2}$/.test(row.before) ? `${row.before}T23:59:59.999Z` : row.before : undefined;
    if (after || before) return { op: 'created', after, before };
  }
  if (row.op === 'engagement' && (row.event === 'open' || row.event === 'click')) {
    const campaignId = typeof row.campaignId === 'string' && row.campaignId ? row.campaignId : undefined;
    const withinDays = Number.isInteger(row.withinDays) && Number(row.withinDays) > 0 && Number(row.withinDays) <= 3650 ? Number(row.withinDays) : undefined;
    const url = row.event === 'click' && typeof row.url === 'string' && /^https?:\/\//i.test(row.url) ? normalizeTrackedUrl(row.url) : undefined;
    if (!campaignId && !withinDays) throw badRequest('互動條件需要電子報或最近天數');
    return { op: 'engagement', event: row.event, campaignId, withinDays, url };
  }
  throw badRequest('受眾條件格式不正確');
}

function matches(condition: AudienceCondition, subscriber: Subscriber, events: TrackingEvent[], now: number): boolean {
  switch (condition.op) {
    case 'and': return condition.children.every((child) => matches(child, subscriber, events, now));
    case 'or': return condition.children.some((child) => matches(child, subscriber, events, now));
    case 'not': return !matches(condition.child, subscriber, events, now);
    case 'tag': return subscriber.tags.includes(condition.tag);
    case 'folder': return condition.folderId === 'unfiled' ? !subscriber.folderId : subscriber.folderId === condition.folderId;
    case 'status': return subscriber.status === condition.status;
    case 'created': return (!condition.after || subscriber.createdAt >= condition.after) && (!condition.before || subscriber.createdAt <= condition.before);
    case 'engagement': return events.some((event) =>
      event.type === condition.event &&
      (!condition.campaignId || event.campaignId === condition.campaignId) &&
      (!condition.withinDays || Date.parse(event.createdAt) >= now - condition.withinDays * 86400000) &&
      (!condition.url || normalizeTrackedUrl(event.url ?? '') === condition.url),
    );
  }
}

function engagements(condition: AudienceCondition): Extract<AudienceCondition, { op: 'engagement' }>[] {
  if (condition.op === 'engagement') return [condition];
  if (condition.op === 'not') return engagements(condition.child);
  if (condition.op === 'and' || condition.op === 'or') return condition.children.flatMap(engagements);
  return [];
}

export async function selectAudience(ctx: ServiceContext, campaign: Pick<Campaign, 'audienceTags' | 'audienceFolderId' | 'audienceCondition'>): Promise<Subscriber[]> {
  const subscribers = await ctx.store.listAudience(audienceFromCampaign(campaign));
  const eligible = (await Promise.all(subscribers.map(async (s) => !s.meta?.suppressedReason && !(await isSuppressed(ctx, s.email)) ? s : null))).filter((s): s is Subscriber => Boolean(s));
  if (eligible.length === 0) return [];
  if (!campaign.audienceCondition) return eligible;
  const needed = engagements(campaign.audienceCondition);
  if (needed.length === 0) return eligible.filter((s) => matches(campaign.audienceCondition!, s, [], Date.now()));
  const now = Date.now();
  const since = needed.every((item) => item.withinDays) ? new Date(now - Math.max(...needed.map((item) => item.withinDays!)) * 86400000).toISOString() : undefined;
  const campaignId = needed.every((item) => item.campaignId && item.campaignId === needed[0]?.campaignId) ? needed[0]?.campaignId : undefined;
  const types = [...new Set(needed.map((item) => item.event))];
  const batches = await Promise.all(types.map((type) => ctx.store.listTrackingEvents({ type, since, campaignId })));
  const bySubscriber = new Map<string, TrackingEvent[]>();
  for (const event of batches.flat()) {
    if (!event.subscriberId) continue;
    const items = bySubscriber.get(event.subscriberId) ?? [];
    items.push(event);
    bySubscriber.set(event.subscriberId, items);
  }
  return eligible.filter((s) => matches(campaign.audienceCondition!, s, bySubscriber.get(s.id) ?? [], now));
}

import { newId, nowIso } from '../core/ids.js';
import type { SequenceTrigger, Subscriber } from '../store/types.js';
import type { ServiceContext } from './context.js';

export type EnrollReason =
  | { type: 'subscribe' }
  | { type: 'tag'; tags: string[] }
  | { type: 'event'; event: string }
  | { type: 'folder'; folderId: string }
  | { type: 'unsubscribe' }
  | { type: 'open'; campaignId: string }
  | { type: 'click'; campaignId: string };

function matches(reason: EnrollReason, trigger: SequenceTrigger, triggerValue?: string): boolean {
  if (reason.type === 'subscribe') return trigger === 'subscribe';
  if (reason.type === 'unsubscribe') return trigger === 'unsubscribe';
  if (reason.type === 'tag') {
    return trigger === 'tag' && !!triggerValue && reason.tags.includes(triggerValue);
  }
  if (reason.type === 'folder') {
    return trigger === 'folder' && !!triggerValue && triggerValue === reason.folderId;
  }
  if (reason.type === 'open') {
    return trigger === 'open' && (!triggerValue || triggerValue === reason.campaignId);
  }
  if (reason.type === 'click') {
    return trigger === 'click' && (!triggerValue || triggerValue === reason.campaignId);
  }
  return trigger === 'event' && triggerValue === reason.event;
}

/** 把人推進符合條件、尚未加入的序列。已在序列裡的不重開。 */
export async function enrollSubscriber(
  ctx: ServiceContext,
  subscriber: Subscriber,
  reason: EnrollReason,
): Promise<number> {
  if (reason.type !== 'unsubscribe' && subscriber.status !== 'subscribed') return 0;
  const sequences = await ctx.store.listSequences();
  let enrolled = 0;
  for (const sequence of sequences) {
    if (!sequence.enabled) continue;
    if (!matches(reason, sequence.trigger, sequence.triggerValue)) continue;
    const existing = await ctx.store.getEnrollment(sequence.id, subscriber.id);
    if (existing) continue;
    const steps = await ctx.store.listSequenceSteps(sequence.id);
    if (steps.length === 0) continue;
    const firstDelay = steps[0]?.delayDays ?? 0;
    const nextRunAt = new Date(Date.now() + firstDelay * 86_400_000).toISOString();
    await ctx.store.createEnrollment({
      id: newId('enr'),
      sequenceId: sequence.id,
      subscriberId: subscriber.id,
      stepIndex: 0,
      nextRunAt,
      status: 'active',
      createdAt: nowIso(),
    });
    enrolled += 1;
  }
  return enrolled;
}

import { campaignHasBody } from '../core/body.js';
import { badRequest, notFound } from '../core/errors.js';
import { newId, nowIso } from '../core/ids.js';
import { logger } from '../core/logger.js';
import { optionalString, requireString } from '../core/validate.js';
import type { Sequence, SequenceStep, SequenceTrigger } from '../store/types.js';
import type { ServiceContext } from './context.js';
import { sendCampaignToSubscriber } from './sending.js';

const TRIGGERS: SequenceTrigger[] = ['subscribe', 'tag', 'event', 'folder', 'unsubscribe', 'open', 'click'];
const REQUIRES_VALUE: SequenceTrigger[] = ['tag', 'folder', 'event'];

function parseTrigger(value: unknown): SequenceTrigger {
  if (typeof value === 'string' && TRIGGERS.includes(value as SequenceTrigger)) {
    return value as SequenceTrigger;
  }
  throw badRequest(`觸發只能是 ${TRIGGERS.join(' / ')}`);
}

export interface SequenceInput {
  name?: unknown;
  trigger?: unknown;
  triggerValue?: unknown;
  enabled?: unknown;
  steps?: unknown;
}

export interface SequenceWithSteps extends Sequence {
  steps: SequenceStep[];
  stats: { active: number; completed: number; canceled: number };
}

function parseSteps(sequenceId: string, raw: unknown): SequenceStep[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw badRequest('步驟格式不正確');
  return raw.slice(0, 12).map((item, index) => {
    const row = (item ?? {}) as { delayDays?: unknown; campaignId?: unknown };
    const delayDays = Number(row.delayDays ?? 0);
    if (!Number.isFinite(delayDays) || delayDays < 0 || delayDays > 365) {
      throw badRequest('延遲天數要在 0–365 之間');
    }
    const campaignId =
      typeof row.campaignId === 'string' ? row.campaignId.trim() : '';
    return {
      id: newId('stp'),
      sequenceId,
      position: index,
      delayDays: Math.floor(delayDays),
      campaignId,
    };
  });
}

async function withSteps(ctx: ServiceContext, sequence: Sequence): Promise<SequenceWithSteps> {
  const [steps, enrollments] = await Promise.all([
    ctx.store.listSequenceSteps(sequence.id),
    ctx.store.listEnrollments(sequence.id),
  ]);
  const stats = { active: 0, completed: 0, canceled: 0 };
  for (const enrollment of enrollments) {
    if (enrollment.status === 'active') stats.active += 1;
    else if (enrollment.status === 'completed') stats.completed += 1;
    else stats.canceled += 1;
  }
  return { ...sequence, steps, stats };
}

export async function listSequencesWithSteps(ctx: ServiceContext): Promise<SequenceWithSteps[]> {
  const sequences = await ctx.store.listSequences();
  return Promise.all(sequences.map((sequence) => withSteps(ctx, sequence)));
}

export async function getSequenceWithSteps(
  ctx: ServiceContext,
  id: string,
): Promise<SequenceWithSteps> {
  const sequence = await ctx.store.getSequence(id);
  if (!sequence) throw notFound('找不到這條序列');
  return withSteps(ctx, sequence);
}

export async function createSequence(
  ctx: ServiceContext,
  input: SequenceInput,
): Promise<SequenceWithSteps> {
  const timestamp = nowIso();
  const trigger = parseTrigger(input.trigger ?? 'subscribe');
  const triggerValue = optionalString(input.triggerValue, '觸發值', 80);
  if (REQUIRES_VALUE.includes(trigger) && !triggerValue) {
    throw badRequest(
      trigger === 'tag' ? '請填標籤名稱' : trigger === 'folder' ? '請選擇資料夾' : '請填事件名稱',
    );
  }
  const sequence = await ctx.store.createSequence({
    id: newId('seq'),
    name: requireString(input.name, '名稱', 120),
    trigger,
    triggerValue,
    enabled: input.enabled === false ? false : true,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const steps = parseSteps(sequence.id, input.steps);
  if (steps.length > 0) await ctx.store.replaceSequenceSteps(sequence.id, steps);
  return withSteps(ctx, sequence);
}

export async function updateSequence(
  ctx: ServiceContext,
  id: string,
  input: SequenceInput,
): Promise<SequenceWithSteps> {
  const current = await ctx.store.getSequence(id);
  if (!current) throw notFound('找不到這條序列');
  const patch: Partial<Sequence> = { updatedAt: nowIso() };
  if (input.name !== undefined) patch.name = requireString(input.name, '名稱', 120);
  if (input.trigger !== undefined) patch.trigger = parseTrigger(input.trigger);
  if (input.triggerValue !== undefined) {
    patch.triggerValue = optionalString(input.triggerValue, '觸發值', 80);
  }
  if (input.enabled !== undefined) patch.enabled = Boolean(input.enabled);
  const nextSteps =
    input.steps !== undefined ? parseSteps(id, input.steps) : await ctx.store.listSequenceSteps(id);
  const nextEnabled = input.enabled !== undefined ? Boolean(input.enabled) : current.enabled;
  if (nextEnabled && (nextSteps.length === 0 || nextSteps.some((step) => !step.campaignId))) {
    throw badRequest('啟用前請先選好要寄的電子報');
  }
  const updated = (await ctx.store.updateSequence(id, patch))!;
  if (input.steps !== undefined) {
    await ctx.store.replaceSequenceSteps(id, nextSteps);
  }
  return withSteps(ctx, updated);
}

export async function deleteSequence(ctx: ServiceContext, id: string): Promise<void> {
  const deleted = await ctx.store.deleteSequence(id);
  if (!deleted) throw notFound('找不到這條序列');
}

export async function processDueEnrollments(ctx: ServiceContext): Promise<number> {
  const due = await ctx.store.findDueEnrollments(nowIso());
  let sent = 0;
  for (const enrollment of due) {
    const sequence = await ctx.store.getSequence(enrollment.sequenceId);
    if (!sequence || !sequence.enabled) {
      await ctx.store.updateEnrollment(enrollment.id, { status: 'canceled' });
      continue;
    }
    const steps = await ctx.store.listSequenceSteps(enrollment.sequenceId);
    const step = steps[enrollment.stepIndex];
    if (!step) {
      await ctx.store.updateEnrollment(enrollment.id, { status: 'completed' });
      continue;
    }
    const subscriber = await ctx.store.getSubscriber(enrollment.subscriberId);
    const campaign = await ctx.store.getCampaign(step.campaignId);
    const allowUnsubscribed = sequence.trigger === 'unsubscribe';
    if (
      !subscriber ||
      (!allowUnsubscribed && subscriber.status !== 'subscribed') ||
      !campaign ||
      !campaignHasBody(campaign)
    ) {
      await ctx.store.updateEnrollment(enrollment.id, { status: 'canceled' });
      continue;
    }
    const result = await sendCampaignToSubscriber(ctx, campaign, subscriber, { allowUnsubscribed });
    if (!result.ok) {
      logger.warn('序列信寄送失敗', {
        enrollmentId: enrollment.id,
        error: result.error,
      });
    } else {
      sent += 1;
    }
    const nextIndex = enrollment.stepIndex + 1;
    const nextStep = steps[nextIndex];
    if (!nextStep) {
      await ctx.store.updateEnrollment(enrollment.id, { status: 'completed', stepIndex: nextIndex });
      continue;
    }
    const waitDays = Math.max(0, nextStep.delayDays - step.delayDays);
    await ctx.store.updateEnrollment(enrollment.id, {
      stepIndex: nextIndex,
      nextRunAt: new Date(Date.now() + waitDays * 86_400_000).toISOString(),
    });
  }
  return sent;
}

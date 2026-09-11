import { badRequest } from '../core/errors.js';
import { newId, nowIso } from '../core/ids.js';
import { logger } from '../core/logger.js';
import { sendMessages } from '../email/registry.js';
import type { EmailMessage } from '../email/types.js';
import type { Campaign, Delivery } from '../store/types.js';
import type { ServiceContext } from './context.js';
import { getCampaign, renderCampaign } from './campaigns.js';
import { unsubscribeUrl } from './subscribers.js';

const inFlight = new Set<string>();

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    if (ms <= 0) resolve();
    else setTimeout(resolve, ms).unref?.();
  });

export interface SendSummary {
  campaignId: string;
  total: number;
  sent: number;
  failed: number;
  status: Campaign['status'];
}

/** 寄測試信給指定地址，不建立 delivery 紀錄、不動名單。 */
export async function sendTestEmail(
  ctx: ServiceContext,
  campaignId: string,
  to: string,
): Promise<{ ok: boolean; message: string }> {
  const campaign = await getCampaign(ctx, campaignId);
  const rendered = renderCampaign(ctx, campaign, { email: to, name: '測試收件人' });
  const result = await ctx.adapter.send({
    to,
    from: ctx.config.email.from,
    subject: `[測試] ${rendered.subject}`,
    html: rendered.html,
    text: rendered.text,
    replyTo: ctx.config.email.replyTo,
    unsubscribeUrl: unsubscribeUrl(ctx, to),
  });
  return result.ok
    ? { ok: true, message: `已透過 ${ctx.adapter.name} 送出測試信。` }
    : { ok: false, message: result.error };
}

/** 依 audienceTags 撈出收件人並建立 pending deliveries。 */
async function prepareDeliveries(ctx: ServiceContext, campaign: Campaign): Promise<number> {
  const existing = await ctx.store.listDeliveries(campaign.id, { limit: 1 });
  if (existing.length > 0) {
    // 之前已經建立過（例如中途重啟），直接沿用，不要重複寄。
    return (await ctx.store.deliveryStats(campaign.id)).total;
  }
  const audience = await ctx.store.listAudience(campaign.audienceTags);
  if (audience.length === 0) throw badRequest('目前沒有符合條件的收件人');

  const deliveries: Delivery[] = audience.map((subscriber) => ({
    id: newId('dlv'),
    campaignId: campaign.id,
    subscriberId: subscriber.id,
    email: subscriber.email,
    status: 'pending',
    attempts: 0,
  }));
  await ctx.store.createDeliveries(deliveries);
  return deliveries.length;
}

async function deliverBatch(
  ctx: ServiceContext,
  campaign: Campaign,
  batch: Delivery[],
): Promise<void> {
  const messages: EmailMessage[] = [];
  for (const delivery of batch) {
    const subscriber = await ctx.store.getSubscriber(delivery.subscriberId);
    const recipient = subscriber ?? { email: delivery.email, name: undefined };
    // 中途退訂的人直接跳過，不要寄出去。
    if (subscriber && subscriber.status !== 'subscribed') {
      await ctx.store.updateDelivery(delivery.id, { status: 'skipped', error: '已非訂閱狀態' });
      continue;
    }
    const rendered = renderCampaign(ctx, campaign, recipient);
    messages.push({
      to: delivery.email,
      from: ctx.config.email.from,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      replyTo: ctx.config.email.replyTo,
      unsubscribeUrl: unsubscribeUrl(ctx, delivery.email),
    });
  }
  if (messages.length === 0) return;

  const targets = batch.filter((d) => messages.some((m) => m.to === d.email));
  const results = await sendMessages(ctx.adapter, messages);

  for (const [index, delivery] of targets.entries()) {
    const result = results[index];
    const attempts = delivery.attempts + 1;
    if (result?.ok) {
      await ctx.store.updateDelivery(delivery.id, {
        status: 'sent',
        attempts,
        sentAt: nowIso(),
        providerMessageId: result.id,
        error: undefined,
      });
      continue;
    }
    const error = result?.error ?? '寄送失敗（沒有回傳結果）';
    const canRetry = (result?.retryable ?? true) && attempts < ctx.config.send.maxAttempts;
    await ctx.store.updateDelivery(delivery.id, {
      status: canRetry ? 'pending' : 'failed',
      attempts,
      error,
    });
  }
}

/** 實際跑寄送迴圈：批次 + 批次間節流 + 失敗退避重試。 */
export async function processCampaign(ctx: ServiceContext, campaignId: string): Promise<SendSummary> {
  if (inFlight.has(campaignId)) {
    throw badRequest('這份電子報正在寄送中');
  }
  inFlight.add(campaignId);
  try {
    const campaign = await getCampaign(ctx, campaignId);
    const { batchSize, batchDelayMs, maxAttempts } = ctx.config.send;

    for (let pass = 0; pass < maxAttempts; pass += 1) {
      for (;;) {
        const current = await ctx.store.getCampaign(campaignId);
        if (!current || current.status === 'canceled') break;

        const pending = (await ctx.store.listDeliveries(campaignId, {
          status: 'pending',
          limit: batchSize * 4,
        })).filter((d) => d.attempts <= pass);
        if (pending.length === 0) break;

        for (let i = 0; i < pending.length; i += batchSize) {
          await deliverBatch(ctx, campaign, pending.slice(i, i + batchSize));
          if (i + batchSize < pending.length) await sleep(batchDelayMs);
        }
      }
      const remaining = await ctx.store.listDeliveries(campaignId, { status: 'pending', limit: 1 });
      if (remaining.length === 0) break;
      // 還有可重試的，退避後再跑一輪。
      await sleep(batchDelayMs * (pass + 1));
    }

    // 重試用完還是 pending 的，收尾標成失敗。
    for (const delivery of await ctx.store.listDeliveries(campaignId, { status: 'pending' })) {
      await ctx.store.updateDelivery(delivery.id, {
        status: 'failed',
        error: delivery.error ?? '超過重試次數',
      });
    }

    const stats = await ctx.store.deliveryStats(campaignId);
    const latest = await ctx.store.getCampaign(campaignId);
    if (latest?.status === 'canceled') {
      return { campaignId, ...stats, status: 'canceled' };
    }
    const status: Campaign['status'] = stats.sent > 0 ? 'sent' : 'failed';
    await ctx.store.updateCampaign(campaignId, {
      status,
      sentAt: nowIso(),
      updatedAt: nowIso(),
    });
    logger.info('電子報寄送結束', { campaignId, ...stats, status });
    return { campaignId, ...stats, status };
  } finally {
    inFlight.delete(campaignId);
  }
}

export interface StartOptions {
  /** true = 立刻回應、背景繼續寄（HTTP 端點用）；false = 等寄完（測試用） */
  background?: boolean;
}

export async function startCampaign(
  ctx: ServiceContext,
  campaignId: string,
  options: StartOptions = {},
): Promise<{ total: number; summary?: SendSummary }> {
  const campaign = await getCampaign(ctx, campaignId);
  if (campaign.status === 'sending') throw badRequest('這份電子報正在寄送中');
  if (campaign.status === 'sent') throw badRequest('這份電子報已經寄過了');
  if (campaign.bodyMarkdown.trim() === '') throw badRequest('內文還是空的，不能寄送');

  const total = await prepareDeliveries(ctx, campaign);
  await ctx.store.updateCampaign(campaignId, {
    status: 'sending',
    scheduledAt: campaign.scheduledAt ?? null,
    updatedAt: nowIso(),
  });

  if (options.background) {
    void processCampaign(ctx, campaignId).catch((error: unknown) => {
      logger.error('背景寄送失敗', { campaignId, error: (error as Error).message });
      void ctx.store.updateCampaign(campaignId, { status: 'failed', updatedAt: nowIso() });
    });
    return { total };
  }
  return { total, summary: await processCampaign(ctx, campaignId) };
}

export async function cancelSending(ctx: ServiceContext, campaignId: string): Promise<Campaign> {
  const campaign = await getCampaign(ctx, campaignId);
  if (campaign.status !== 'sending' && campaign.status !== 'scheduled') {
    throw badRequest('只有排程中或寄送中的電子報可以中止');
  }
  for (const delivery of await ctx.store.listDeliveries(campaignId, { status: 'pending' })) {
    await ctx.store.updateDelivery(delivery.id, { status: 'skipped', error: '已取消寄送' });
  }
  const updated = await ctx.store.updateCampaign(campaignId, {
    status: 'canceled',
    updatedAt: nowIso(),
  });
  return updated!;
}

export const isSending = (campaignId: string): boolean => inFlight.has(campaignId);

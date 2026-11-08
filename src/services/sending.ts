import { scheduleBackgroundWork } from '../core/background.js';
import { campaignHasBody } from '../core/body.js';
import { badRequest } from '../core/errors.js';
import { newId, nowIso } from '../core/ids.js';
import { logger } from '../core/logger.js';
import { injectTracking } from '../core/tracking.js';
import { sendMessages } from '../email/registry.js';
import type { EmailMessage, SendResult } from '../email/types.js';
import { withEmailHeaders } from '../email/headers.js';
import type { Campaign, Delivery, DeliveryUpdate, Subscriber } from '../store/types.js';
import type { ServiceContext } from './context.js';
import { getCampaign, renderCampaign } from './campaigns.js';
import { clearSending, isSendingNow, markSending } from './send-state.js';
import { unsubscribeUrl } from './subscribers.js';
import { selectAudience } from './audience.js';
import { isSuppressed } from './suppression.js';

function trackedHtml(
  ctx: ServiceContext,
  html: string,
  delivery: Pick<Delivery, 'id' | 'campaignId' | 'subscriberId' | 'email'>,
): string {
  if (!ctx.config.trackingEnabled) return html;
  return injectTracking(html, {
    secret: ctx.config.appSecret,
    publicBaseUrl: ctx.config.publicBaseUrl,
    email: delivery.email,
    campaignId: delivery.campaignId,
    deliveryId: delivery.id,
    subscriberId: delivery.subscriberId,
  });
}

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
  /** 已交給供應商但結果未確認的筆數。 */
  unconfirmed?: number | undefined;
  status: Campaign['status'];
  /** 這次寄送提早收手的原因（例如 time_budget）；campaign 仍是 sending。 */
  paused?: 'time_budget' | undefined;
}

/** 寄測試信給指定地址，不建立 delivery 紀錄、不動名單。 */
export async function sendTestEmail(
  ctx: ServiceContext,
  campaignId: string,
  to: string,
): Promise<{ ok: boolean; message: string }> {
  const campaign = await getCampaign(ctx, campaignId);
  const rendered = await renderCampaign(ctx, campaign, { email: to, name: '測試收件人' });
  const result = await ctx.adapter.send(withEmailHeaders({
    to,
    from: ctx.config.email.from,
    subject: `[測試] ${rendered.subject}`,
    html: rendered.html,
    text: rendered.text,
    replyTo: ctx.config.email.replyTo,
    unsubscribeUrl: unsubscribeUrl(ctx, to, { campaignId }),
    unsubscribeMailto: ctx.config.email.unsubscribeMailto,
  }));
  return result.ok
    ? { ok: true, message: `已透過 ${ctx.adapter.name} 送出測試信。` }
    : { ok: false, message: result.error };
}

/** 寄送被擋下的原因；SEND_PAUSED 或資料層停寫時一律不寄。 */
export function sendingBlockedReason(ctx: ServiceContext): string | null {
  if (ctx.config.send.paused) return '寄送已全面暫停（SEND_PAUSED=true），解除前不會寄出任何信';
  const integrity = (ctx.store as { integrityStatus?: () => { ok: boolean; reason?: string } })
    .integrityStatus?.();
  if (integrity && !integrity.ok) {
    return `資料層完整性異常，已停止寄送：${integrity.reason ?? '未知原因'}`;
  }
  return null;
}

function assertSendingAllowed(ctx: ServiceContext): void {
  const reason = sendingBlockedReason(ctx);
  if (reason) throw badRequest(reason);
}

/** 寄送紀錄寫回失敗：供應商可能已收下信，必須停下來，不能繼續寄或重寄。 */
export class SendRecordError extends Error {
  override readonly name = 'SendRecordError';
}

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

/** 依受眾撈出收件人並建立 pending deliveries；同一個 email 只會有一筆。 */
async function prepareDeliveries(ctx: ServiceContext, campaign: Campaign): Promise<number> {
  const existing = await ctx.store.listDeliveries(campaign.id, { limit: 1 });
  if (existing.length > 0) {
    // 之前已經建立過（例如中途重啟），直接沿用，不要重複寄。
    if (campaign.status === 'failed') {
      // 重寄失敗／卡死的電子報：只把 failed 與 pending 重新排入。
      // sending（已交給供應商、結果未確認）一律不動，要先對帳，避免重複寄。
      const all = await ctx.store.listDeliveries(campaign.id);
      const delivered = new Set(
        all.filter((d) => d.status === 'sent' || d.status === 'sending').map((d) => normalizeEmail(d.email)),
      );
      const updates = all
        .filter((d) => d.status === 'failed' || d.status === 'pending')
        .map((d) =>
          delivered.has(normalizeEmail(d.email))
            ? { id: d.id, patch: { status: 'skipped' as const, error: '同一個地址已有寄出或待確認的紀錄' } }
            : { id: d.id, patch: { status: 'pending' as const, attempts: 0, error: undefined } },
        );
      if (updates.length > 0) await ctx.store.updateDeliveries(updates);
    }
    return (await ctx.store.deliveryStats(campaign.id)).total;
  }
  const audience = await selectAudience(ctx, campaign);
  if (audience.length === 0) throw badRequest('目前沒有符合條件的收件人');

  const seen = new Set<string>();
  const deliveries: Delivery[] = [];
  for (const subscriber of audience) {
    const key = normalizeEmail(subscriber.email);
    if (seen.has(key)) continue;
    seen.add(key);
    deliveries.push({
      id: newId('dlv'),
      campaignId: campaign.id,
      subscriberId: subscriber.id,
      email: subscriber.email,
      status: 'pending',
      attempts: 0,
    });
  }
  await ctx.store.createDeliveries(deliveries);
  return deliveries.length;
}

/** 寫回寄送結果；有任何一筆沒寫進去就丟錯停止（那筆可能已寄出卻沒有紀錄）。 */
async function writeResults(ctx: ServiceContext, updates: DeliveryUpdate[]): Promise<void> {
  if (updates.length === 0) return;
  let applied: number;
  try {
    applied = await ctx.store.updateDeliveries(updates);
  } catch (error) {
    throw new SendRecordError(`寄送結果寫回失敗，已停止寄送：${(error as Error).message}`);
  }
  if (applied !== updates.length) {
    throw new SendRecordError(
      `寄送結果只寫回 ${applied}／${updates.length} 筆（寄送紀錄已不存在），已停止寄送`,
    );
  }
}

async function deliverBatch(
  ctx: ServiceContext,
  campaign: Campaign,
  batch: Delivery[],
): Promise<void> {
  assertSendingAllowed(ctx);

  // 中途退訂或被抑制的人直接跳過，不要寄出去。
  const skips: DeliveryUpdate[] = [];
  const candidates: { delivery: Delivery; recipient: { email: string; name?: string | undefined } }[] = [];
  for (const delivery of batch) {
    const subscriber = await ctx.store.getSubscriber(delivery.subscriberId);
    if ((subscriber && (subscriber.status !== 'subscribed' || subscriber.meta?.suppressedReason)) || await isSuppressed(ctx, delivery.email)) {
      skips.push({ id: delivery.id, patch: { status: 'skipped', error: '已非訂閱狀態' } });
      continue;
    }
    candidates.push({ delivery, recipient: subscriber ?? { email: delivery.email, name: undefined } });
  }
  await writeResults(ctx, skips);
  if (candidates.length === 0) return;

  // 先 claim 並持久化，成功領到的才寄；別的實例已領走的不寄。
  const claimedIds = new Set(
    await ctx.store.claimDeliveries(
      candidates.map((c) => c.delivery.id),
      { claimId: newId('clm'), claimedAt: nowIso() },
    ),
  );
  const mine = candidates.filter((c) => claimedIds.has(c.delivery.id));
  if (mine.length === 0) return;

  const messages: EmailMessage[] = [];
  for (const { delivery, recipient } of mine) {
    const rendered = await renderCampaign(ctx, campaign, recipient);
    messages.push({
      to: delivery.email,
      from: ctx.config.email.from,
      subject: rendered.subject,
      html: trackedHtml(ctx, rendered.html, delivery),
      text: rendered.text,
      replyTo: ctx.config.email.replyTo,
      unsubscribeUrl: unsubscribeUrl(ctx, delivery.email, {
        campaignId: campaign.id,
        deliveryId: delivery.id,
        subscriberId: delivery.subscriberId,
      }),
      unsubscribeMailto: ctx.config.email.unsubscribeMailto,
      // 用 delivery id 當冪等鍵：重試同一筆不會被供應商寄第二次。
      idempotencyKey: delivery.id,
    });
  }

  let results: SendResult[];
  try {
    results = await sendMessages(ctx.adapter, messages);
  } catch (error) {
    // 呼叫本身炸掉：不知道供應商收了沒有，全部留在 sending 等對帳。
    results = messages.map(() => ({
      ok: false as const,
      error: `寄送呼叫失敗（結果不明）：${(error as Error).message}`,
      outcomeUnknown: true,
    }));
  }

  const updates: DeliveryUpdate[] = mine.map(({ delivery }, index) => {
    const result = results[index];
    const attempts = delivery.attempts + 1;
    if (result?.ok) {
      return {
        id: delivery.id,
        patch: { status: 'sent', attempts, sentAt: nowIso(), providerMessageId: result.id, error: undefined },
      };
    }
    const error = result?.error ?? '寄送失敗（沒有回傳結果）';
    if (!result || result.outcomeUnknown) {
      // 可能已寄出：留在 sending，不自動重寄。
      return { id: delivery.id, patch: { status: 'sending', attempts, error } };
    }
    const canRetry = (result.retryable ?? true) && attempts < ctx.config.send.maxAttempts;
    return {
      id: delivery.id,
      patch: { status: canRetry ? 'pending' : 'failed', attempts, error, claimId: undefined, claimedAt: undefined },
    };
  });
  await writeResults(ctx, updates);
}

/** 實際跑寄送迴圈：批次 + 批次間節流 + 失敗退避重試。 */
export async function processCampaign(ctx: ServiceContext, campaignId: string): Promise<SendSummary> {
  if (isSendingNow(campaignId)) {
    throw badRequest('這份電子報正在寄送中');
  }
  assertSendingAllowed(ctx);
  markSending(campaignId);
  const startedAt = Date.now();
  const budgetMs = ctx.config.send.timeBudgetMs ?? 0;
  const outOfTime = () => budgetMs > 0 && Date.now() - startedAt > budgetMs;
  try {
    const campaign = await getCampaign(ctx, campaignId);
    const { batchSize, batchDelayMs, maxAttempts } = ctx.config.send;

    for (let pass = 0; pass < maxAttempts; pass += 1) {
      for (;;) {
        const current = await ctx.store.getCampaign(campaignId);
        if (!current) {
          // 寄到一半電子報不見了：資料層出事，停下來，不要繼續寄。
          throw new SendRecordError('寄送中的電子報紀錄消失，已停止寄送');
        }
        if (current.status === 'canceled') break;

        const pending = (await ctx.store.listDeliveries(campaignId, {
          status: 'pending',
          limit: batchSize * 4,
        })).filter((d) => d.attempts <= pass);
        if (pending.length === 0) break;

        for (let i = 0; i < pending.length; i += batchSize) {
          if (outOfTime()) {
            // 快到函式時間上限：先收手，紀錄都已寫回，留給人工（或 SEND_AUTO_RESUME）續寄。
            logger.warn('單次寄送時間用完，先暫停', { campaignId, elapsedMs: Date.now() - startedAt });
            await ctx.store.updateCampaign(campaignId, { updatedAt: nowIso() });
            const stats = await ctx.store.deliveryStats(campaignId);
            return { campaignId, ...stats, status: 'sending', paused: 'time_budget' };
          }
          await deliverBatch(ctx, campaign, pending.slice(i, i + batchSize));
          // 心跳：updatedAt 代表「還有進度」，別的實例才不會把活著的寄送當成卡死。
          await ctx.store.updateCampaign(campaignId, { updatedAt: nowIso() });
          if (i + batchSize < pending.length) await sleep(batchDelayMs);
        }
      }
      const remaining = await ctx.store.listDeliveries(campaignId, { status: 'pending', limit: 1 });
      if (remaining.length === 0) break;
      // 還有可重試的，退避後再跑一輪。
      await sleep(batchDelayMs * (pass + 1));
    }

    // 重試用完還是 pending 的，收尾標成失敗。
    const leftovers = await ctx.store.listDeliveries(campaignId, { status: 'pending' });
    await writeResults(
      ctx,
      leftovers.map((d) => ({ id: d.id, patch: { status: 'failed' as const, error: d.error ?? '超過重試次數' } })),
    );

    const stats = await ctx.store.deliveryStats(campaignId);
    const latest = await ctx.store.getCampaign(campaignId);
    if (latest?.status === 'canceled') {
      return { campaignId, ...stats, status: 'canceled' };
    }
    // 有結果不明的寄送紀錄：標成失敗讓後台看得到，但那些紀錄不會被重寄（要先對帳）。
    const status: Campaign['status'] = stats.sent > 0 && !stats.unconfirmed ? 'sent' : 'failed';
    await ctx.store.updateCampaign(campaignId, {
      status,
      sentAt: nowIso(),
      updatedAt: nowIso(),
    });
    logger.info('電子報寄送結束', { campaignId, ...stats, status });
    return { campaignId, ...stats, status };
  } finally {
    clearSending(campaignId);
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
  assertSendingAllowed(ctx);
  const campaign = await getCampaign(ctx, campaignId);
  if (campaign.status === 'sending') throw badRequest('這份電子報正在寄送中');
  if (campaign.status === 'sent') throw badRequest('這份電子報已經寄過了');
  if (!campaignHasBody(campaign)) throw badRequest('內文還是空的，不能寄送');

  const total = await prepareDeliveries(ctx, campaign);
  await ctx.store.updateCampaign(campaignId, {
    status: 'sending',
    scheduledAt: campaign.scheduledAt ?? null,
    updatedAt: nowIso(),
  });

  const run = async (): Promise<SendSummary | undefined> => {
    try {
      return await processCampaign(ctx, campaignId);
    } catch (error) {
      logger.error('背景寄送失敗', { campaignId, error: (error as Error).message });
      // 不能卡在「寄送中」或悄悄變回草稿：明確標成失敗，後台才看得到。
      try {
        await ctx.store.updateCampaign(campaignId, { status: 'failed', updatedAt: nowIso() });
      } catch (markError) {
        logger.error('標記寄送失敗狀態也失敗', {
          campaignId,
          error: (markError as Error).message,
        });
      }
      return undefined;
    }
  };

  if (options.background) {
    // Vercel 用 waitUntil 讓工作在回應後繼續跑；長駐程序照舊 fire-and-forget。
    if (scheduleBackgroundWork(run)) return { total };
    // serverless 拿不到 waitUntil 時退回「請求內寄完」，否則函式一凍結寄送就斷頭。
    const summary = await run();
    return summary ? { total, summary } : { total };
  }
  return { total, summary: await processCampaign(ctx, campaignId) };
}

/** 人工續寄「寄送中」但沒有程序在跑的電子報（例如時間預算用完或重啟後）。 */
export async function resumeCampaign(
  ctx: ServiceContext,
  campaignId: string,
  options: StartOptions = {},
): Promise<{ started: boolean; summary?: SendSummary }> {
  assertSendingAllowed(ctx);
  const campaign = await ctx.store.getCampaign(campaignId);
  if (!campaign) throw badRequest('找不到這份電子報');
  if (campaign.status !== 'sending') throw badRequest('只有寄送中的電子報可以續寄');
  if (isSendingNow(campaignId)) throw badRequest('這份電子報正在寄送中');
  const run = () =>
    processCampaign(ctx, campaignId).catch((error) => {
      logger.error('續寄失敗', { campaignId, error: (error as Error).message });
      return undefined;
    });
  if (options.background && scheduleBackgroundWork(run)) return { started: true };
  const summary = await run();
  return summary ? { started: true, summary } : { started: true };
}

export interface ReconcileSummary {
  checked: number;
  confirmed: number;
  stillUnknown: number;
  supported: boolean;
}

/**
 * 對帳：把停在 sending（結果不明）的寄送紀錄拿去供應商查。
 * 查到 → 標成 sent；查不到 → 維持 sending，不自動重寄，由人工決定。
 */
export async function reconcileUnconfirmed(ctx: ServiceContext, campaignId: string): Promise<ReconcileSummary> {
  const unconfirmed = await ctx.store.listDeliveries(campaignId, { status: 'sending', limit: 100_000 });
  if (unconfirmed.length === 0) return { checked: 0, confirmed: 0, stillUnknown: 0, supported: true };
  if (!ctx.adapter.findSentByRefs) {
    return { checked: unconfirmed.length, confirmed: 0, stillUnknown: unconfirmed.length, supported: false };
  }
  const earliest = unconfirmed
    .map((d) => d.claimedAt)
    .filter((v): v is string => !!v)
    .sort()[0];
  const since = new Date(Date.parse(earliest ?? nowIso()) - 10 * 60 * 1000).toISOString();
  const found = await ctx.adapter.findSentByRefs(unconfirmed.map((d) => d.id), since);
  const updates: DeliveryUpdate[] = [];
  for (const delivery of unconfirmed) {
    const record = found.get(delivery.id);
    if (!record) continue;
    updates.push({
      id: delivery.id,
      patch: {
        status: 'sent',
        providerMessageId: record.providerMessageId ?? delivery.providerMessageId,
        sentAt: record.acceptedAt ?? delivery.claimedAt ?? nowIso(),
        error: undefined,
      },
    });
  }
  await writeResults(ctx, updates);
  return {
    checked: unconfirmed.length,
    confirmed: updates.length,
    stillUnknown: unconfirmed.length - updates.length,
    supported: true,
  };
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

export const isSending = (campaignId: string): boolean => isSendingNow(campaignId);

/** 序列信：只寄給一個人，不改範本 campaign 的狀態。 */
export async function sendCampaignToSubscriber(
  ctx: ServiceContext,
  campaign: Campaign,
  subscriber: Subscriber,
  options: { allowUnsubscribed?: boolean } = {},
): Promise<{ ok: boolean; error?: string }> {
  const blocked = sendingBlockedReason(ctx);
  if (blocked) return { ok: false, error: blocked };
  if (subscriber.meta?.suppressedReason || await isSuppressed(ctx, subscriber.email) || (subscriber.status !== 'subscribed' && !options.allowUnsubscribed)) {
    return { ok: false, error: '已非訂閱狀態' };
  }
  const delivery: Delivery = {
    id: newId('dlv'),
    campaignId: campaign.id,
    subscriberId: subscriber.id,
    email: subscriber.email,
    status: 'pending',
    attempts: 1,
  };
  await ctx.store.createDeliveries([delivery]);
  const rendered = await renderCampaign(ctx, campaign, subscriber);
  const result = await ctx.adapter.send(withEmailHeaders({
    to: subscriber.email,
    from: ctx.config.email.from,
    subject: rendered.subject,
    html: trackedHtml(ctx, rendered.html, delivery),
    text: rendered.text,
    replyTo: ctx.config.email.replyTo,
    unsubscribeUrl: unsubscribeUrl(ctx, subscriber.email, {
      campaignId: campaign.id,
      deliveryId: delivery.id,
      subscriberId: subscriber.id,
    }),
    unsubscribeMailto: ctx.config.email.unsubscribeMailto,
    idempotencyKey: delivery.id,
  }));
  if (result.ok) {
    await ctx.store.updateDelivery(delivery.id, {
      status: 'sent',
      sentAt: nowIso(),
      providerMessageId: result.id,
    });
    return { ok: true };
  }
  await ctx.store.updateDelivery(delivery.id, {
    status: 'failed',
    error: result.error,
  });
  return { ok: false, error: result.error };
}

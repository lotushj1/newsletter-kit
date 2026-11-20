import { scheduleBackgroundWork } from '../core/background.js';
import { campaignHasBody } from '../core/body.js';
import { AppError, badRequest } from '../core/errors.js';
import { newId, nowIso } from '../core/ids.js';
import { logger } from '../core/logger.js';
import { injectTracking } from '../core/tracking.js';
import { sendMessages } from '../email/registry.js';
import type { EmailMessage, SendResult } from '../email/types.js';
import { withEmailHeaders } from '../email/headers.js';
import type { Campaign, Delivery, DeliveryReconcile, DeliveryUpdate, Subscriber } from '../store/types.js';
import type { ServiceContext } from './context.js';
import { receiptFromProviderStatus } from './delivery-receipts.js';
import { getBrand } from './brand.js';
import { getCampaign, renderCampaign } from './campaigns.js';
import { clearSending, isSendingNow, markSending } from './send-state.js';
import { unsubscribeUrl } from './subscribers.js';
import { audienceBreakdown } from './audience.js';
import { checkStoreReadiness, noteStoreWriteFailure, STORE_UNAVAILABLE, storeProblem } from './store-readiness.js';
import { isSuppressed, suppressedEmails } from './suppression.js';

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

const STORE_BLOCKED_PREFIX = '資料庫目前無法寫入，已停止寄送';

/**
 * 寄送被擋下的原因；SEND_PAUSED、資料層停寫，或最近一次檢查發現資料庫寫不進去（InsForge 逐表沒有
 * integrityStatus，靠 store-readiness 的寫入探測與 schema 版本）時一律不寄。
 */
export function sendingBlockedReason(ctx: ServiceContext): string | null {
  if (ctx.config.send.paused) return '寄送已全面暫停（SEND_PAUSED=true），解除前不會寄出任何信';
  const integrity = (ctx.store as { integrityStatus?: () => { ok: boolean; reason?: string } })
    .integrityStatus?.();
  if (integrity && !integrity.ok) {
    return `資料層完整性異常，已停止寄送：${integrity.reason ?? '未知原因'}`;
  }
  const problem = storeProblem(ctx);
  if (problem) return `${STORE_BLOCKED_PREFIX}：${problem}`;
  return null;
}

function assertSendingAllowed(ctx: ServiceContext): void {
  const reason = sendingBlockedReason(ctx);
  if (!reason) return;
  throw reason.startsWith(STORE_BLOCKED_PREFIX) ? new AppError(reason, 503, STORE_UNAVAILABLE) : badRequest(reason);
}

/** 寄送紀錄寫回失敗：供應商可能已收下信，必須停下來，不能繼續寄或重寄。 */
export class SendRecordError extends Error {
  override readonly name = 'SendRecordError';
}

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

/** 因時間預算暫停後，排程器在這段時間內會自動接續；超過就要人工按「繼續寄送」。 */
export const AUTO_CONTINUE_WINDOW_MS = 15 * 60 * 1000;

/** 這份寄送是不是「剛因時間預算暫停」：只有這種才會被排程自動接續。 */
export function isFreshTimeBudgetPause(campaign: Pick<Campaign, 'status' | 'sendPauseReason' | 'sendPausedAt'>, now = Date.now()): boolean {
  if (campaign.status !== 'sending' || campaign.sendPauseReason !== 'time_budget' || !campaign.sendPausedAt) return false;
  const pausedAt = Date.parse(campaign.sendPausedAt);
  return Number.isFinite(pausedAt) && now - pausedAt <= AUTO_CONTINUE_WINDOW_MS;
}

/**
 * 重寄失敗／卡死的電子報，或「已寄出但有一部分失敗」的電子報：只把 failed 與 pending 重新排入。
 * sending（已交給供應商、結果未確認）一律不動，要先對帳，避免重複寄。
 * duplicate＝同一個地址已有寄出或待確認的紀錄，改成跳過。
 */
function planResend(all: Delivery[]): { delivery: Delivery; duplicate: boolean }[] {
  const delivered = new Set(
    all.filter((d) => d.status === 'sent' || d.status === 'sending').map((d) => normalizeEmail(d.email)),
  );
  // 寄信服務已經收下、事後才回報失敗的（退信、拒收名單，有 providerMessageId）不重寄：
  // 對方信箱收不到，重寄只會再失敗，也避免同一封信送給寄信服務兩次。
  return all
    .filter((d) => d.status === 'pending' || (d.status === 'failed' && !d.providerMessageId))
    .map((delivery) => ({ delivery, duplicate: delivered.has(normalizeEmail(delivery.email)) }));
}

/** 寄出前會被跳過：已非訂閱狀態、被標記抑制，或在排除名單上。 */
function skippedAtSend(delivery: Delivery, subscriber: Subscriber | null, suppressed: Set<string>): boolean {
  return Boolean(subscriber && (subscriber.status !== 'subscribed' || subscriber.meta?.suppressedReason)) ||
    suppressed.has(normalizeEmail(delivery.email));
}

/** 依受眾撈出收件人並建立 pending deliveries；同一個 email 只會有一筆。 */
async function prepareDeliveries(ctx: ServiceContext, campaign: Campaign): Promise<number> {
  const existing = await ctx.store.listDeliveries(campaign.id, { limit: 1 });
  if (existing.length > 0) {
    // 之前已經建立過（例如中途重啟），直接沿用，不要重複寄。
    if (campaign.status === 'failed' || campaign.status === 'sent') {
      const updates = planResend(await ctx.store.listDeliveries(campaign.id)).map(({ delivery: d, duplicate }) =>
        duplicate
          ? { id: d.id, patch: { status: 'skipped' as const, error: '同一個地址已有寄出或待確認的紀錄' } }
          : { id: d.id, patch: { status: 'pending' as const, attempts: 0, error: undefined } },
      );
      if (updates.length > 0) await ctx.store.updateDeliveries(updates);
    }
    return (await ctx.store.deliveryStats(campaign.id)).total;
  }
  const { recipients: audience } = await audienceBreakdown(ctx, campaign);
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

export interface RecipientPreview {
  /** audience＝依受眾條件建立寄送紀錄；resend＝之前寄過，這次只補寄失敗與還沒寄出的。 */
  mode: 'audience' | 'resend';
  /** 實際會寄出的人數（已扣掉退訂、退信與排除名單）。 */
  count: number;
  /** 符合條件、但因退訂、退信或排除名單不會寄的人數。 */
  excluded: number;
}

/**
 * 按下寄送（或排程時間到）會寄給幾個人：跟 prepareDeliveries＋deliverBatch 用同一套規則，
 * 給寄送確認視窗顯示。campaign 可帶尚未存檔的受眾條件。
 */
export async function previewRecipients(ctx: ServiceContext, campaign: Campaign): Promise<RecipientPreview> {
  const existing = await ctx.store.listDeliveries(campaign.id, { limit: 1 });
  if (existing.length === 0) {
    const { recipients, excluded } = await audienceBreakdown(ctx, campaign);
    const count = new Set(recipients.map((s) => normalizeEmail(s.email))).size;
    return { mode: 'audience', count, excluded };
  }
  const all = await ctx.store.listDeliveries(campaign.id);
  const queued = campaign.status === 'failed' || campaign.status === 'sent'
    ? planResend(all).filter((p) => !p.duplicate).map((p) => p.delivery)
    : all.filter((d) => d.status === 'pending');
  const subscribers = new Map(
    (await ctx.store.getSubscribersByIds(queued.map((d) => d.subscriberId))).map((s) => [s.id, s]),
  );
  const suppressed = await suppressedEmails(ctx, queued.map((d) => d.email));
  const excluded = queued.filter((d) => skippedAtSend(d, subscribers.get(d.subscriberId) ?? null, suppressed)).length;
  return { mode: 'resend', count: queued.length - excluded, excluded };
}

/** 寫回寄送結果；有任何一筆沒寫進去就丟錯停止（那筆可能已寄出卻沒有紀錄）。 */
async function writeResults(ctx: ServiceContext, updates: DeliveryUpdate[]): Promise<void> {
  if (updates.length === 0) return;
  let applied: number;
  try {
    applied = await ctx.store.updateDeliveries(updates);
  } catch (error) {
    // 資料庫寫不進去：記下來，之後的批次與寄送先擋住，直到重新檢查通過。
    noteStoreWriteFailure(ctx, (error as Error).message);
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
  // 整批讀訂閱者與排除名單（各一次查詢），不要每封各打一次資料庫。
  const subscribers = new Map(
    (await ctx.store.getSubscribersByIds(batch.map((d) => d.subscriberId))).map((s) => [s.id, s]),
  );
  const suppressed = await suppressedEmails(ctx, batch.map((d) => d.email));
  for (const delivery of batch) {
    const subscriber = subscribers.get(delivery.subscriberId) ?? null;
    if (skippedAtSend(delivery, subscriber, suppressed)) {
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
  const brand = await getBrand(ctx);
  for (const { delivery, recipient } of mine) {
    const rendered = await renderCampaign(ctx, campaign, recipient, brand);
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

  const updates: DeliveryUpdate[] = mine.map(({ delivery }, index) => ({
    id: delivery.id,
    patch: resultPatch(delivery, results[index], { maxAttempts: ctx.config.send.maxAttempts, allowRetry: true }),
  }));
  await writeResults(ctx, updates);
}

/**
 * 把供應商的回應轉成寄送紀錄的更新。電子報寄送與序列信共用同一套規則：
 * - 成功：sent，記下服務商訊息 id，回報先記為 accepted（服務商已收下，不等於已送達）。
 * - 結果不明（逾時、斷線、5xx、呼叫本身丟錯）：留在 sending 等對帳，不自動重寄。
 * - 確定沒收下：可重試就回到 pending（allowRetry），否則 failed。
 */
function resultPatch(
  delivery: Pick<Delivery, 'attempts'>,
  result: SendResult | undefined,
  options: { maxAttempts: number; allowRetry: boolean },
): Partial<Delivery> {
  const attempts = delivery.attempts + 1;
  if (result?.ok) {
    const at = nowIso();
    return {
      status: 'sent',
      attempts,
      sentAt: at,
      providerMessageId: result.id,
      error: undefined,
      receipt: 'accepted',
      receiptAt: at,
    };
  }
  const error = result?.error ?? '寄送失敗（沒有回傳結果）';
  if (!result || result.outcomeUnknown) {
    // 可能已寄出：留在 sending，不自動重寄。
    return { status: 'sending', attempts, error };
  }
  const canRetry = options.allowRetry && (result.retryable ?? true) && attempts < options.maxAttempts;
  return { status: canRetry ? 'pending' : 'failed', attempts, error, claimId: undefined, claimedAt: undefined };
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
    if (campaign.sendPauseReason) {
      await ctx.store.updateCampaign(campaignId, { sendPausedAt: null, sendPauseReason: null, updatedAt: nowIso() });
    }

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
            await ctx.store.updateCampaign(campaignId, {
              updatedAt: nowIso(),
              sendPausedAt: nowIso(),
              sendPauseReason: 'time_budget',
            });
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
  await checkStoreReadiness(ctx);
  assertSendingAllowed(ctx);
  const campaign = await getCampaign(ctx, campaignId);
  if (campaign.status === 'sending') throw badRequest('這份電子報正在寄送中');
  if (campaign.status === 'sent') {
    // 已寄出但有失敗的收件人：允許只重寄失敗的那些（已寄出的地址會被跳過，不會收到兩次）。
    const stats = await ctx.store.deliveryStats(campaignId);
    if (stats.unconfirmed) throw badRequest('還有結果不明的寄送紀錄，請先對帳再重寄');
    if (stats.failed === 0) throw badRequest('這份電子報已經寄過了');
  }
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
  await checkStoreReadiness(ctx);
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
  /** 服務商查得到的筆數（含查到但回報沒送達的）。 */
  confirmed: number;
  stillUnknown: number;
  supported: boolean;
  /** 服務商查得到、但回報退信或沒寄出的筆數：已標成失敗，不會重寄。 */
  undelivered: number;
  /** 這次對帳的結論與原因；每筆寄送紀錄另外記在 reconcile.note。 */
  reason: string;
  /** 查詢本身失敗時的錯誤訊息。 */
  lookupError?: string | undefined;
}

/** 對帳時向服務商查詢的起點：最早一筆領取時間再往前 10 分鐘（時鐘誤差）。 */
function lookupSince(deliveries: Delivery[]): string {
  const earliest = deliveries
    .map((d) => d.claimedAt)
    .filter((v): v is string => !!v)
    .sort()[0];
  return new Date(Date.parse(earliest ?? nowIso()) - 10 * 60 * 1000).toISOString();
}

/**
 * 對帳：把停在 sending（結果不明）的寄送紀錄拿去供應商查。
 * 一律產生結果與原因並記在每筆紀錄（誰、何時、查到什麼），絕不盲目重寄：
 * - 查到 → 標成 sent，並記下服務商回報的收件狀態（已送達／被檢舉…）；
 *   服務商回報退信或沒寄出的 → 標成 failed（有服務商訊息 id，重寄時會跳過）。
 * - 查不到、服務商沒有查詢 API、查詢失敗 → 維持 sending，由人工到服務商後台確認。
 */
export async function reconcileUnconfirmed(
  ctx: ServiceContext,
  campaignId: string,
  actor = '系統',
): Promise<ReconcileSummary> {
  const unconfirmed = await ctx.store.listDeliveries(campaignId, { status: 'sending', limit: 100_000 });
  const empty = { confirmed: 0, undelivered: 0 };
  if (unconfirmed.length === 0) {
    return { checked: 0, ...empty, stillUnknown: 0, supported: true, reason: '沒有結果不明的寄送紀錄' };
  }
  const at = nowIso();
  const note = (result: DeliveryReconcile['result'], text: string): DeliveryReconcile => ({ at, by: actor, result, note: text });
  const markAll = (reconcile: DeliveryReconcile): DeliveryUpdate[] =>
    unconfirmed.map((d) => ({ id: d.id, patch: { reconcile } }));

  if (!ctx.adapter.findSentByRefs) {
    const reason =
      `目前的寄信服務（${ctx.adapter.name}）沒有查詢 API，無法自動對帳。` +
      '請到服務商後台用收件地址與寄送時間確認；這些紀錄維持結果不明，不會自動重寄。';
    await writeResults(ctx, markAll(note('unsupported', reason)));
    return { checked: unconfirmed.length, ...empty, stillUnknown: unconfirmed.length, supported: false, reason };
  }

  const since = lookupSince(unconfirmed);
  let found: Awaited<ReturnType<NonNullable<typeof ctx.adapter.findSentByRefs>>>;
  try {
    found = await ctx.adapter.findSentByRefs(unconfirmed.map((d) => d.id), since);
  } catch (error) {
    const message = (error as Error).message;
    const reason = `向寄信服務查詢失敗：${message}。這些紀錄維持結果不明，不會自動重寄，請稍後再對帳一次。`;
    await writeResults(ctx, markAll(note('lookup_failed', reason)));
    return {
      checked: unconfirmed.length,
      ...empty,
      stillUnknown: unconfirmed.length,
      supported: true,
      reason,
      lookupError: message,
    };
  }

  const updates: DeliveryUpdate[] = [];
  let confirmed = 0;
  let undelivered = 0;
  for (const delivery of unconfirmed) {
    const record = found.get(delivery.id);
    if (!record) {
      updates.push({
        id: delivery.id,
        patch: {
          reconcile: note(
            'not_found',
            '寄信服務查不到這封信（從這批最早交件時間前 10 分鐘開始查）。可能沒有寄出，也可能紀錄還沒出現；維持結果不明，不會自動重寄。',
          ),
        },
      });
      continue;
    }
    confirmed += 1;
    const receipt = receiptFromProviderStatus(record.recipientStatus);
    const providerMessageId = record.providerMessageId ?? delivery.providerMessageId;
    // 沒送達要標 failed，但一定要有服務商訊息 id：重寄規則靠它判斷「服務商收過」而跳過。
    const notDelivered = (receipt === 'bounced' || receipt === 'failed') && !!providerMessageId;
    if (notDelivered) undelivered += 1;
    const statusText = record.recipientStatus ? `，收件狀態 ${record.recipientStatus}` : '';
    const acceptedText = record.acceptedAt ? `受理時間 ${record.acceptedAt}` : '受理時間不明';
    updates.push({
      id: delivery.id,
      patch: {
        status: notDelivered ? 'failed' : 'sent',
        providerMessageId,
        sentAt: record.acceptedAt ?? delivery.claimedAt ?? at,
        error: notDelivered
          ? `寄信服務回報${receipt === 'bounced' ? '退信' : '沒有寄出'}（${record.recipientStatus}，對帳時查到）`
          : undefined,
        receipt,
        receiptAt: at,
        reconcile: note(
          'confirmed',
          `寄信服務查到這封信（${acceptedText}${statusText}）` +
            (notDelivered ? '，但回報沒有送達，已標為失敗（不會重寄）。' : '，已標為已寄出。'),
        ),
      },
    });
  }
  await writeResults(ctx, updates);
  const stillUnknown = unconfirmed.length - confirmed;
  const reason =
    `對帳完成：服務商查到 ${confirmed} 筆（其中回報沒送達 ${undelivered} 筆，已標為失敗、不會重寄），` +
    `仍不明 ${stillUnknown} 筆。` +
    (stillUnknown > 0 ? '查不到的維持結果不明、不會自動重寄，請到服務商後台確認。' : '');
  return { checked: unconfirmed.length, confirmed, undelivered, stillUnknown, supported: true, reason };
}

export interface ReconcileQueueItem {
  id: string;
  campaignId: string;
  campaignTitle: string;
  /** 電子報目前的狀態；sending 代表可能還在寄、結果還沒寫回。 */
  campaignStatus: Campaign['status'] | 'missing';
  email: string;
  /** 交給服務商的時間（最早發生時間）。 */
  claimedAt?: string | undefined;
  attempts: number;
  error?: string | undefined;
  providerMessageId?: string | undefined;
  /** 向服務商查詢用的參考值：冪等鍵／ref 標籤，等於寄送紀錄 id。 */
  lookupRef: string;
  reconcile?: DeliveryReconcile | undefined;
}

export interface ReconcileQueue {
  total: number;
  /** 最早一筆交給服務商的時間。 */
  earliestAt: string | null;
  /** 目前的寄信服務能不能自動查詢（不能就只能到服務商後台人工確認）。 */
  lookup: { provider: string; supported: boolean };
  items: ReconcileQueueItem[];
}

/** 跨電子報的「待對帳」清單：所有結果不明（sending）的寄送紀錄，最早的排前面。 */
export async function listReconcileQueue(ctx: ServiceContext, options: { limit?: number } = {}): Promise<ReconcileQueue> {
  const limit = options.limit ?? 500;
  const rows = (await ctx.store.listDeliveriesByStatus('sending')).sort((a, b) =>
    (a.claimedAt ?? '').localeCompare(b.claimedAt ?? ''),
  );
  const campaigns = new Map<string, Campaign | null>();
  for (const campaignId of new Set(rows.slice(0, limit).map((d) => d.campaignId))) {
    campaigns.set(campaignId, await ctx.store.getCampaign(campaignId));
  }
  const items = rows.slice(0, limit).map((d): ReconcileQueueItem => {
    const campaign = campaigns.get(d.campaignId) ?? null;
    return {
      id: d.id,
      campaignId: d.campaignId,
      campaignTitle: campaign?.title ?? '（電子報已不存在）',
      campaignStatus: campaign?.status ?? 'missing',
      email: d.email,
      claimedAt: d.claimedAt,
      attempts: d.attempts,
      error: d.error,
      providerMessageId: d.providerMessageId,
      lookupRef: d.id,
      reconcile: d.reconcile ?? undefined,
    };
  });
  return {
    total: rows.length,
    earliestAt: rows.find((d) => d.claimedAt)?.claimedAt ?? null,
    lookup: { provider: ctx.adapter.name, supported: Boolean(ctx.adapter.findSentByRefs) },
    items,
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

/** 序列信寄送紀錄的固定 id：同一個入隊的同一步永遠是同一筆，重跑也不會寄第二封。 */
export function sequenceDeliveryId(enrollmentId: string, stepIndex: number): string {
  return `dlv_seq_${enrollmentId.replace(/[^A-Za-z0-9_-]/g, '-')}_${stepIndex}`;
}

/**
 * 序列信：只寄給一個人，不改範本 campaign 的狀態。
 * 跟電子報寄送用同一套保護：先建立並 claim 寄送紀錄、成功領到才寄；
 * 結果不明（逾時、5xx、呼叫丟錯）留在 sending 等對帳，不自動重寄。
 * 給 deliveryId（序列用 sequenceDeliveryId）時，這筆之前處理過就直接回報上次的結果。
 */
export async function sendCampaignToSubscriber(
  ctx: ServiceContext,
  campaign: Campaign,
  subscriber: Subscriber,
  options: { allowUnsubscribed?: boolean; deliveryId?: string } = {},
): Promise<{ ok: boolean; error?: string; outcomeUnknown?: boolean }> {
  const blocked = sendingBlockedReason(ctx);
  if (blocked) return { ok: false, error: blocked };
  if (subscriber.meta?.suppressedReason || await isSuppressed(ctx, subscriber.email) || (subscriber.status !== 'subscribed' && !options.allowUnsubscribed)) {
    return { ok: false, error: '已非訂閱狀態' };
  }
  const id = options.deliveryId ?? newId('dlv');
  const existing = options.deliveryId ? await ctx.store.getDelivery(id) : null;
  if (existing) {
    if (existing.campaignId !== campaign.id) {
      return { ok: false, error: '序列信寄送紀錄 id 已被別的電子報使用，沒有寄出' };
    }
    if (existing.status !== 'pending') {
      if (existing.status === 'sent') return { ok: true };
      if (existing.status === 'sending') {
        return { ok: false, error: existing.error ?? '上次寄送結果不明，等對帳，不重寄', outcomeUnknown: true };
      }
      return { ok: false, error: existing.error ?? '這一步之前已處理過，不重寄' };
    }
  }
  // 先算好內容再建立寄送紀錄：算到一半失敗不會留下「已領取卻沒寄」的紀錄。
  const rendered = await renderCampaign(ctx, campaign, subscriber);
  const delivery: Delivery = {
    id,
    campaignId: campaign.id,
    subscriberId: subscriber.id,
    email: subscriber.email,
    status: 'pending',
    attempts: 0,
  };
  // 之前建立了卻沒領走（例如中途重啟）的待寄紀錄直接沿用。
  if (!existing) await ctx.store.createDeliveries([delivery]);
  const claimed = await ctx.store.claimDeliveries([id], { claimId: newId('clm'), claimedAt: nowIso() });
  if (!claimed.includes(id)) {
    // 別的程序已經領走這筆（或它不再是待寄）：不寄，避免同一人收到兩封。
    return { ok: false, error: '這封序列信已由其他寄送程序處理，沒有重複寄出' };
  }
  const message: EmailMessage = {
    to: subscriber.email,
    from: ctx.config.email.from,
    subject: rendered.subject,
    html: trackedHtml(ctx, rendered.html, delivery),
    text: rendered.text,
    replyTo: ctx.config.email.replyTo,
    unsubscribeUrl: unsubscribeUrl(ctx, subscriber.email, {
      campaignId: campaign.id,
      deliveryId: id,
      subscriberId: subscriber.id,
    }),
    unsubscribeMailto: ctx.config.email.unsubscribeMailto,
    idempotencyKey: id,
  };
  let result: SendResult | undefined;
  try {
    [result] = await sendMessages(ctx.adapter, [message]);
  } catch (error) {
    result = { ok: false, error: `寄送呼叫失敗（結果不明）：${(error as Error).message}`, outcomeUnknown: true };
  }
  // 序列信沒有重試迴圈：確定失敗就記 failed，結果不明留在 sending。
  const patch = resultPatch(existing ?? delivery, result, { maxAttempts: 1, allowRetry: false });
  await writeResults(ctx, [{ id, patch }]);
  if (result?.ok) return { ok: true };
  const error = patch.error ?? '寄送失敗';
  return patch.status === 'sending' ? { ok: false, error, outcomeUnknown: true } : { ok: false, error };
}

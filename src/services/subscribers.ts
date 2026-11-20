import { parseCsv, toCsv } from '../core/csv.js';
import { badRequest, conflict, notFound } from '../core/errors.js';
import { newId, nowIso } from '../core/ids.js';
import { logger } from '../core/logger.js';
import { applyVariables, htmlToText, renderEmailLayout } from '../core/render.js';
import { emailBrandName } from '../core/brand-signature.js';
import { confirmEmailContentHtml } from '../core/system-emails.js';
import { createToken, verifyToken } from '../core/tokens.js';
import { normalizeEmail, normalizeTags, optionalString } from '../core/validate.js';
import { syncSubscriberToNotion } from './notion-sync.js';
import {
  clearUnsubscribeSuppression,
  recordBounce,
  recordUnsubscribe,
  statusForSuppression,
  suppressionReasonFor,
} from './suppression.js';
import { currentDisclosure, withConsent } from './consent.js';
import type { Paged, Subscriber, SubscriberQuery, SubscriberStatus } from '../store/types.js';
import type { ServiceContext } from './context.js';
import { getBrand } from './brand.js';
import { enrollSubscriber } from './enroll.js';
import { resolveFolderId } from './folders.js';

const CONFIRM_MAX_AGE_SECONDS = 60 * 60 * 24 * 14;

export interface SubscribeInput {
  email: unknown;
  name?: unknown;
  tags?: unknown;
  source?: unknown;
}

export type SubscribeOutcome =
  | { status: 'pending'; message: string; subscriber: Subscriber }
  | { status: 'subscribed'; message: string; subscriber: Subscriber }
  | { status: 'already_subscribed'; message: string; subscriber: Subscriber };

export function confirmUrl(ctx: ServiceContext, email: string): string {
  const token = createToken(ctx.config.appSecret, 'confirm', email);
  return `${ctx.config.publicBaseUrl}/confirm?token=${encodeURIComponent(token)}`;
}

export function unsubscribeUrl(
  ctx: ServiceContext,
  email: string,
  extra?: { campaignId?: string; deliveryId?: string; subscriberId?: string },
): string {
  const token = createToken(ctx.config.appSecret, 'unsubscribe', email, extra);
  return `${ctx.config.publicBaseUrl}/unsubscribe?token=${encodeURIComponent(token)}`;
}

async function sendConfirmEmail(ctx: ServiceContext, subscriber: Subscriber): Promise<void> {
  const link = confirmUrl(ctx, subscriber.email);
  // 刊頭跟電子報用同一個品牌名稱；內文需要一個名字時，都沒設就退回 SITE_NAME。
  const brand = await getBrand(ctx);
  const brandName = emailBrandName(brand, ctx.config.siteName);
  const name = brandName || ctx.config.siteName;
  const contentHtml = confirmEmailContentHtml(name, link);
  const html = renderEmailLayout({
    subject: `確認訂閱 ${name}`,
    preheader: '點一下連結就完成訂閱',
    contentHtml,
    siteName: brandName,
    footerNote: '這封信是因為有人用這個地址申請訂閱才寄出的。',
    physicalAddress: brand.physicalAddress,
    privacyUrl: brand.privacyUrl,
  });

  const result = await ctx.adapter.send({
    to: subscriber.email,
    from: ctx.config.email.from,
    subject: `確認訂閱 ${name}`,
    html,
    text: htmlToText(html),
    replyTo: ctx.config.email.replyTo,
  });
  if (!result.ok) {
    logger.error('確認信寄送失敗', { email: subscriber.email, error: result.error });
  }
}

/** 公開訂閱入口。double opt-in 開啟時建立 pending 並寄確認信。 */
export async function subscribe(
  ctx: ServiceContext,
  input: SubscribeInput,
): Promise<SubscribeOutcome> {
  const email = normalizeEmail(input.email);
  const name = optionalString(input.name, '名稱', 120);
  const tags = normalizeTags(input.tags);
  const source = optionalString(input.source, '來源', 120);
  const existing = await ctx.store.getSubscriberByEmail(email);
  const suppressed = await suppressionReasonFor(ctx, email);
  // 退訂過（或被刪除前退訂過）的人要重新訂閱，一律要本人點確認信，單次同意的來源也一樣。
  const previouslyUnsubscribed = existing?.status === 'unsubscribed' || suppressed === 'unsubscribe';
  const doubleOptIn =
    previouslyUnsubscribed ||
    (ctx.config.doubleOptIn && !(source && (ctx.config.singleOptInSources ?? []).includes(source.toLowerCase())));
  const { textVersion } = await currentDisclosure(ctx);

  if (existing) {
    if (existing.status === 'subscribed') {
      return {
        status: 'already_subscribed',
        message: '這個 Email 已經在名單內了。',
        subscriber: existing,
      };
    }
    // 退訂過或還沒確認的人重新訂閱：回到流程起點，不要留著舊狀態。
    const merged = [...new Set([...existing.tags, ...tags])];
    if (doubleOptIn) {
      const updated = (await ctx.store.updateSubscriber(existing.id, {
        status: 'pending',
        name: name ?? existing.name,
        tags: merged,
        unsubscribedAt: undefined,
        meta: { ...existing.meta, consentRequest: { source: source ?? existing.source ?? 'public_form', at: nowIso(), textVersion } },
      }))!;
      syncSubscriberToNotion(updated.email, updated.status);
      await sendConfirmEmail(ctx, updated);
      return { status: 'pending', message: '確認信已寄出，請到信箱點確認連結。', subscriber: updated };
    }
    await clearUnsubscribeSuppression(ctx, email);
    const updated = (await ctx.store.updateSubscriber(existing.id, {
      status: 'subscribed',
      name: name ?? existing.name,
      tags: merged,
      confirmedAt: nowIso(),
      unsubscribedAt: undefined,
      meta: withConsent(existing.meta, { method: 'single_opt_in', source: source ?? 'public_form', textVersion }),
    }))!;
    syncSubscriberToNotion(updated.email, updated.status);
    await enrollSubscriber(ctx, updated, { type: 'subscribe' });
    if (merged.length > 0) await enrollSubscriber(ctx, updated, { type: 'tag', tags: merged });
    return { status: 'subscribed', message: '訂閱成功。', subscriber: updated };
  }

  const status: SubscriberStatus = doubleOptIn ? 'pending' : 'subscribed';
  if (status === 'subscribed') await clearUnsubscribeSuppression(ctx, email);
  const created = await ctx.store.createSubscriber({
    id: newId('sub'),
    email,
    name,
    status,
    tags,
    source: source ?? 'public_form',
    createdAt: nowIso(),
    confirmedAt: status === 'subscribed' ? nowIso() : undefined,
    meta:
      status === 'subscribed'
        ? withConsent(undefined, { method: 'single_opt_in', source: source ?? 'public_form', textVersion })
        : { consentRequest: { source: source ?? 'public_form', at: nowIso(), textVersion } },
  });
  syncSubscriberToNotion(created.email, created.status);

  if (status === 'pending') {
    await sendConfirmEmail(ctx, created);
    return { status: 'pending', message: '確認信已寄出，請到信箱點確認連結。', subscriber: created };
  }
  await enrollSubscriber(ctx, created, { type: 'subscribe' });
  if (tags.length > 0) await enrollSubscriber(ctx, created, { type: 'tag', tags });
  return { status: 'subscribed', message: '訂閱成功。', subscriber: created };
}

export async function confirmSubscription(
  ctx: ServiceContext,
  token: string,
): Promise<{ ok: boolean; message: string }> {
  const verified = verifyToken(ctx.config.appSecret, token, 'confirm', CONFIRM_MAX_AGE_SECONDS);
  if (!verified) return { ok: false, message: '這個確認連結無效或已過期，請重新訂閱。' };

  const subscriber = await ctx.store.getSubscriberByEmail(verified.email);
  if (!subscriber) return { ok: false, message: '找不到對應的訂閱資料，請重新訂閱。' };
  if (subscriber.status === 'subscribed') return { ok: true, message: '你已經完成訂閱了。' };
  // 只有「等待確認」的人能用確認連結完成訂閱。確認連結 14 天內有效，
  // 期間退訂（或退信）的人點到舊連結，不能因此被加回名單。
  if (subscriber.status !== 'pending') {
    return { ok: false, message: '這個確認連結已經失效。如果想重新訂閱，請再填一次訂閱表單。' };
  }

  await clearUnsubscribeSuppression(ctx, subscriber.email);
  const request = subscriber.meta?.consentRequest as { source?: string; at?: string; textVersion?: string } | undefined;
  const { consentRequest: _request, ...restMeta } = subscriber.meta ?? {};
  const confirmed = (await ctx.store.updateSubscriber(subscriber.id, {
    status: 'subscribed',
    confirmedAt: nowIso(),
    unsubscribedAt: undefined,
    meta: withConsent(restMeta, {
      method: 'double_opt_in',
      source: request?.source ?? subscriber.source ?? 'public_form',
      textVersion: request?.textVersion,
      requestedAt: request?.at,
    }),
  }))!;
  syncSubscriberToNotion(confirmed.email, confirmed.status);
  await enrollSubscriber(ctx, confirmed, { type: 'subscribe' });
  if (confirmed.tags.length > 0) {
    await enrollSubscriber(ctx, confirmed, { type: 'tag', tags: confirmed.tags });
  }
  return { ok: true, message: '訂閱完成，之後的電子報會寄到這個信箱。' };
}

export async function unsubscribeByToken(
  ctx: ServiceContext,
  token: string,
): Promise<{ ok: boolean; message: string }> {
  const verified = verifyToken(ctx.config.appSecret, token, 'unsubscribe');
  if (!verified) return { ok: false, message: '這個退訂連結無效。' };
  return unsubscribeByEmail(ctx, verified.email, {
    campaignId: verified.campaignId,
    deliveryId: verified.deliveryId,
    subscriberId: verified.subscriberId,
  });
}

export async function unsubscribeByEmail(
  ctx: ServiceContext,
  email: string,
  source?: { campaignId?: string; deliveryId?: string; subscriberId?: string },
): Promise<{ ok: boolean; message: string }> {
  const subscriber = await ctx.store.getSubscriberByEmail(email.toLowerCase());
  if (!subscriber) {
    // 名單裡找不到（可能是資料遺失期間）也要留下退訂紀錄，不能只回成功。
    await recordUnsubscribe(ctx, email);
    return { ok: true, message: '已退訂，之後不會再寄信到這個地址。' };
  }
  // 名單裡的人退訂也要記進排除名單；之後被刪除再匯入、或從舊備份還原，也不會再寄給他。
  await recordUnsubscribe(ctx, subscriber.email);
  if (subscriber.status === 'unsubscribed') return { ok: true, message: '你已經退訂了。' };
  const updated = await ctx.store.updateSubscriber(subscriber.id, {
    status: 'unsubscribed',
    unsubscribedAt: nowIso(),
  });
  if (updated) syncSubscriberToNotion(updated.email, updated.status);
  if (updated) await enrollSubscriber(ctx, updated, { type: 'unsubscribe' });
  if (updated && source?.campaignId) {
    await ctx.store.createEvent({
      id: newId('evt'),
      campaignId: source.campaignId,
      subscriberId: source.subscriberId ?? updated.id,
      deliveryId: source.deliveryId,
      type: 'unsubscribe',
      createdAt: nowIso(),
    });
  }
  return { ok: true, message: '已退訂，不會再收到電子報。' };
}

// ── 後台操作 ────────────────────────────────────────────────

export interface AdminSubscriberInput {
  email: unknown;
  name?: unknown;
  tags?: unknown;
  folderId?: unknown;
  status?: unknown;
  source?: unknown;
}

const STATUSES: SubscriberStatus[] = ['pending', 'subscribed', 'unsubscribed', 'bounced'];

function parseStatus(value: unknown, fallback: SubscriberStatus): SubscriberStatus {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'string' && STATUSES.includes(value as SubscriberStatus)) {
    return value as SubscriberStatus;
  }
  throw badRequest(`狀態只能是 ${STATUSES.join(' / ')}`);
}

/** 後台手動新增：預設直接算已訂閱（管理者自己負責取得同意）。 */
/**
 * 退訂、退信、檢舉過的地址不能由後台或上游直接改回「已訂閱」，要本人重新訂閱並點確認信。
 * 寄送時本來就會跳過排除名單，這裡擋下來是為了不讓名單上出現「已訂閱但永遠收不到」的人。
 */
async function assertNotSuppressed(ctx: ServiceContext, email: string, current?: Subscriber): Promise<void> {
  const reason = await suppressionReasonFor(ctx, email);
  const blockedStatus = current && (current.status === 'unsubscribed' || current.status === 'bounced');
  if (!reason && !blockedStatus) return;
  const what = reason === 'bounce' || current?.status === 'bounced' ? '退信' : reason === 'complaint' ? '檢舉' : '退訂';
  throw conflict(`這個地址先前${what}過，不能直接改回已訂閱；請本人重新填寫訂閱表單並點確認信。`);
}

export async function createSubscriber(
  ctx: ServiceContext,
  input: AdminSubscriberInput,
  options?: { consentMethod?: 'admin' | 'ingest' },
): Promise<Subscriber> {
  const email = normalizeEmail(input.email);
  const status = parseStatus(input.status, 'subscribed');
  const source = optionalString(input.source, '來源', 120) ?? 'admin';
  if (status === 'subscribed') await assertNotSuppressed(ctx, email);
  const created = await ctx.store.createSubscriber({
    id: newId('sub'),
    email,
    name: optionalString(input.name, '名稱', 120),
    status,
    tags: normalizeTags(input.tags),
    folderId: await resolveFolderId(ctx, input.folderId),
    source,
    createdAt: nowIso(),
    meta:
      status === 'subscribed'
        ? withConsent(undefined, { method: options?.consentMethod ?? 'admin', source })
        : undefined,
  });
  if (status === 'unsubscribed') await recordUnsubscribe(ctx, email);
  if (status === 'bounced') await recordBounce(ctx, email);
  syncSubscriberToNotion(created.email, created.status);
  if (created.status === 'subscribed') {
    await enrollSubscriber(ctx, created, { type: 'subscribe' });
    if (created.tags.length > 0) await enrollSubscriber(ctx, created, { type: 'tag', tags: created.tags });
    if (created.folderId) await enrollSubscriber(ctx, created, { type: 'folder', folderId: created.folderId });
  }
  return created;
}

export async function updateSubscriber(
  ctx: ServiceContext,
  id: string,
  input: Partial<AdminSubscriberInput>,
): Promise<Subscriber> {
  const current = await ctx.store.getSubscriber(id);
  if (!current) throw notFound('找不到這位訂閱者');

  const patch: Partial<Subscriber> = {};
  if (input.email !== undefined) {
    const email = normalizeEmail(input.email);
    if (email !== current.email) {
      const taken = await ctx.store.getSubscriberByEmail(email);
      if (taken && taken.id !== id) throw conflict('這個 Email 已在名單內');
    }
    patch.email = email;
  }
  if (input.name !== undefined) patch.name = optionalString(input.name, '名稱', 120);
  if (input.tags !== undefined) patch.tags = normalizeTags(input.tags);
  if (input.folderId !== undefined) patch.folderId = await resolveFolderId(ctx, input.folderId);
  if (input.status !== undefined) {
    const status = parseStatus(input.status, current.status);
    if (status === 'subscribed' && current.status !== 'subscribed') {
      await assertNotSuppressed(ctx, patch.email ?? current.email, current);
      patch.meta = withConsent(current.meta, { method: 'admin', source: current.source ?? 'admin' });
    }
    patch.status = status;
    if (status === 'unsubscribed' && current.status !== 'unsubscribed') patch.unsubscribedAt = nowIso();
  }
  const updated = await ctx.store.updateSubscriber(id, patch);
  if (!updated) throw notFound('找不到這位訂閱者');
  if (updated.status === 'unsubscribed' && current.status !== 'unsubscribed') await recordUnsubscribe(ctx, updated.email);
  if (updated.status === 'bounced' && current.status !== 'bounced') await recordBounce(ctx, updated.email);
  if (updated.status !== current.status || updated.email !== current.email) {
    syncSubscriberToNotion(updated.email, updated.status);
  }
  if (updated.status === 'subscribed') {
    if (input.tags !== undefined) {
      const added = updated.tags.filter((tag) => !current.tags.includes(tag));
      if (added.length > 0) await enrollSubscriber(ctx, updated, { type: 'tag', tags: added });
    }
    if (updated.folderId && updated.folderId !== current.folderId) {
      await enrollSubscriber(ctx, updated, { type: 'folder', folderId: updated.folderId });
    }
  }
  if (updated.status === 'unsubscribed' && current.status !== 'unsubscribed') {
    await enrollSubscriber(ctx, updated, { type: 'unsubscribe' });
  }
  return updated;
}

export async function deleteSubscriber(ctx: ServiceContext, id: string): Promise<void> {
  const current = await ctx.store.getSubscriber(id);
  if (!current) throw notFound('找不到這位訂閱者');
  // 刪掉退訂或退信的人之前，先把排除紀錄留下來（舊資料可能還沒有）；
  // 否則之後重新匯入，他會以「已訂閱」回到名單。排除名單只存 Email 的雜湊。
  if (current.status === 'unsubscribed') await recordUnsubscribe(ctx, current.email);
  if (current.status === 'bounced') await recordBounce(ctx, current.email);
  const deleted = await ctx.store.deleteSubscriber(id);
  if (!deleted) throw notFound('找不到這位訂閱者');
}

export function listSubscribers(
  ctx: ServiceContext,
  query: SubscriberQuery,
): Promise<Paged<Subscriber>> {
  return ctx.store.listSubscribers(query);
}

export function listSubscriberTags(ctx: ServiceContext): Promise<string[]> {
  return ctx.store.listSubscriberTags();
}

export interface ImportResult {
  created: number;
  updated: number;
  skipped: number;
  /** 新加入名單、但先前退訂／退信／檢舉過的人：照樣建檔，狀態維持不寄送。 */
  suppressed: number;
  errors: string[];
}

/**
 * CSV 匯入。第一列若含 email 欄名就當表頭，否則視為無表頭、第一欄是 email。
 * 支援欄位：email、name、tags（用 `|` 或 `;` 分隔）、status、folder。
 */
export async function importSubscribersCsv(
  ctx: ServiceContext,
  csvText: string,
  defaultTags: string[] = [],
  defaultFolderId?: string,
): Promise<ImportResult> {
  const rows = parseCsv(csvText);
  if (rows.length === 0) throw badRequest('CSV 沒有可匯入的資料');

  const first = rows[0]!.map((cell) => cell.trim().toLowerCase());
  const hasHeader = first.includes('email');
  const header = hasHeader ? first : ['email', 'name', 'tags', 'status', 'folder'];
  const dataRows = hasHeader ? rows.slice(1) : rows;
  const columnOf = (field: string): number => header.indexOf(field);
  const folderByName = new Map(
    (await ctx.store.listFolders()).map((folder) => [folder.name.toLowerCase(), folder.id]),
  );
  const resolvedDefault = defaultFolderId ? await resolveFolderId(ctx, defaultFolderId) : undefined;

  const folderIdFor = async (name: string | undefined): Promise<string | undefined> => {
    const trimmed = name?.trim();
    if (!trimmed) return resolvedDefault;
    const existing = folderByName.get(trimmed.toLowerCase());
    if (existing) return existing;
    const created = await ctx.store.createFolder({
      id: newId('fld'),
      name: trimmed.slice(0, 40),
      kind: 'subscribers',
      createdAt: nowIso(),
    });
    folderByName.set(created.name.toLowerCase(), created.id);
    return created.id;
  };

  const result: ImportResult = { created: 0, updated: 0, skipped: 0, suppressed: 0, errors: [] };

  for (const [index, row] of dataRows.entries()) {
    const emailCell = row[columnOf('email') === -1 ? 0 : columnOf('email')] ?? '';
    const lineNo = index + (hasHeader ? 2 : 1);
    let email: string;
    try {
      email = normalizeEmail(emailCell);
    } catch {
      result.skipped += 1;
      if (result.errors.length < 20) result.errors.push(`第 ${lineNo} 行：Email 無效（${emailCell}）`);
      continue;
    }

    const nameCol = columnOf('name');
    const tagsCol = columnOf('tags');
    const statusCol = columnOf('status');
    const folderCol = columnOf('folder');
    const name = nameCol >= 0 ? (row[nameCol]?.trim() || undefined) : undefined;
    const rowTags = tagsCol >= 0 ? (row[tagsCol] ?? '').split(/[|;]/) : [];
    const tags = normalizeTags([...defaultTags, ...rowTags]);
    const folderId = await folderIdFor(folderCol >= 0 ? row[folderCol] : undefined);
    let status: SubscriberStatus = 'subscribed';
    if (statusCol >= 0) {
      try {
        status = parseStatus(row[statusCol]?.trim(), 'subscribed');
      } catch {
        status = 'subscribed';
      }
    }

    const existing = await ctx.store.getSubscriberByEmail(email);
    if (existing) {
      const merged = [...new Set([...existing.tags, ...tags])];
      const added = merged.filter((t) => !existing.tags.includes(t));
      const updated = (await ctx.store.updateSubscriber(existing.id, {
        name: name ?? existing.name,
        tags: merged,
        folderId: folderId ?? existing.folderId,
      }))!;
      if (added.length > 0) await enrollSubscriber(ctx, updated, { type: 'tag', tags: added });
      if (updated.folderId && updated.folderId !== existing.folderId) {
        await enrollSubscriber(ctx, updated, { type: 'folder', folderId: updated.folderId });
      }
      result.updated += 1;
      continue;
    }
    const suppressedReason = await suppressionReasonFor(ctx, email);
    if (suppressedReason && status === 'subscribed') {
      status = statusForSuppression(suppressedReason);
      result.suppressed += 1;
      if (result.errors.length < 20) {
        result.errors.push(`第 ${lineNo} 行：這個地址先前${suppressedReason === 'bounce' ? '退信' : suppressedReason === 'complaint' ? '檢舉' : '退訂'}過，已加入名單但不會寄送`);
      }
    }
    // 匯入的人沒有點過確認信，不填 confirmedAt；同意由匯入者負責取得，記在 meta.consent。
    const created = await ctx.store.createSubscriber({
      id: newId('sub'),
      email,
      name,
      status,
      tags,
      folderId,
      source: 'import',
      createdAt: nowIso(),
      meta: status === 'subscribed' ? withConsent(undefined, { method: 'import', source: 'import' }) : undefined,
    });
    if (status === 'unsubscribed') await recordUnsubscribe(ctx, email);
    if (status === 'bounced') await recordBounce(ctx, email);
    if (status === 'subscribed') {
      if (tags.length > 0) await enrollSubscriber(ctx, created, { type: 'tag', tags });
      if (folderId) await enrollSubscriber(ctx, created, { type: 'folder', folderId });
    }
    result.created += 1;
  }

  return result;
}

/**
 * 單一訂閱者的個人資料匯出（本人來信要求查詢時用）：訂閱資料、同意紀錄、排除名單狀態、
 * 每一封的寄送狀態與開信點擊。不含信件內容與確認／退訂 token。
 */
export async function exportSubscriberData(ctx: ServiceContext, id: string): Promise<Record<string, unknown>> {
  const subscriber = await ctx.store.getSubscriber(id);
  if (!subscriber) throw notFound('找不到這位訂閱者');
  const { deliveries, events } = await ctx.store.listSubscriberActivity(id);
  return {
    exportedAt: nowIso(),
    subscriber,
    suppression: await suppressionReasonFor(ctx, subscriber.email),
    deliveries: deliveries.map((d) => ({
      id: d.id,
      campaignId: d.campaignId,
      status: d.status,
      sentAt: d.sentAt,
      error: d.error,
    })),
    events: events.map((e) => ({ type: e.type, campaignId: e.campaignId, url: e.url, createdAt: e.createdAt })),
  };
}

export async function exportSubscribersCsv(ctx: ServiceContext): Promise<string> {
  const all: Subscriber[] = [];
  const pageSize = 500;
  for (let offset = 0; ; offset += pageSize) {
    const page = await ctx.store.listSubscribers({ limit: pageSize, offset });
    all.push(...page.items);
    if (all.length >= page.total || page.items.length === 0) break;
  }
  const folders = new Map((await ctx.store.listFolders()).map((folder) => [folder.id, folder.name]));
  return toCsv(
    ['email', 'name', 'status', 'tags', 'folder', 'source', 'created_at', 'confirmed_at', 'unsubscribed_at'],
    all.map((s) => [
      s.email,
      s.name ?? '',
      s.status,
      s.tags.join('|'),
      (s.folderId && folders.get(s.folderId)) || '',
      s.source ?? '',
      s.createdAt,
      s.confirmedAt ?? '',
      s.unsubscribedAt ?? '',
    ]),
  );
}

/** 給訂閱者用的個人化變數，寄送與預覽共用。 */
export function subscriberVariables(
  ctx: ServiceContext,
  subscriber: Pick<Subscriber, 'email' | 'name'>,
): Record<string, string> {
  return {
    name: subscriber.name ?? '朋友',
    email: subscriber.email,
    site_name: ctx.config.siteName,
    unsubscribe_url: unsubscribeUrl(ctx, subscriber.email),
  };
}

export const renderWithVariables = applyVariables;

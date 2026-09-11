import { parseCsv, toCsv } from '../core/csv.js';
import { badRequest, notFound } from '../core/errors.js';
import { newId, nowIso } from '../core/ids.js';
import { logger } from '../core/logger.js';
import { applyVariables, htmlToText, markdownToHtml, renderEmailLayout } from '../core/render.js';
import { createToken, verifyToken } from '../core/tokens.js';
import { normalizeEmail, normalizeTags, optionalString } from '../core/validate.js';
import type { Paged, Subscriber, SubscriberQuery, SubscriberStatus } from '../store/types.js';
import type { ServiceContext } from './context.js';

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

export function unsubscribeUrl(ctx: ServiceContext, email: string): string {
  const token = createToken(ctx.config.appSecret, 'unsubscribe', email);
  return `${ctx.config.publicBaseUrl}/unsubscribe?token=${encodeURIComponent(token)}`;
}

async function sendConfirmEmail(ctx: ServiceContext, subscriber: Subscriber): Promise<void> {
  const link = confirmUrl(ctx, subscriber.email);
  const contentHtml = markdownToHtml(
    [
      `### 再一步就完成訂閱`,
      '',
      `請點下面的連結確認你要收到 ${ctx.config.siteName} 的電子報。`,
      '',
      `[確認訂閱](${link})`,
      '',
      '如果這不是你本人操作，直接忽略這封信就好，我們不會把你加進名單。',
    ].join('\n'),
  );
  const html = renderEmailLayout({
    subject: `確認訂閱 ${ctx.config.siteName}`,
    preheader: '點一下連結就完成訂閱',
    contentHtml,
    siteName: ctx.config.siteName,
    footerNote: '這封信是因為有人用這個地址申請訂閱才寄出的。',
  });

  const result = await ctx.adapter.send({
    to: subscriber.email,
    from: ctx.config.email.from,
    subject: `確認訂閱 ${ctx.config.siteName}`,
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
    if (ctx.config.doubleOptIn) {
      const updated = (await ctx.store.updateSubscriber(existing.id, {
        status: 'pending',
        name: name ?? existing.name,
        tags: merged,
        unsubscribedAt: undefined,
      }))!;
      await sendConfirmEmail(ctx, updated);
      return { status: 'pending', message: '確認信已寄出，請到信箱點確認連結。', subscriber: updated };
    }
    const updated = (await ctx.store.updateSubscriber(existing.id, {
      status: 'subscribed',
      name: name ?? existing.name,
      tags: merged,
      confirmedAt: nowIso(),
      unsubscribedAt: undefined,
    }))!;
    return { status: 'subscribed', message: '訂閱成功。', subscriber: updated };
  }

  const status: SubscriberStatus = ctx.config.doubleOptIn ? 'pending' : 'subscribed';
  const created = await ctx.store.createSubscriber({
    id: newId('sub'),
    email,
    name,
    status,
    tags,
    source: source ?? 'public_form',
    createdAt: nowIso(),
    confirmedAt: status === 'subscribed' ? nowIso() : undefined,
  });

  if (status === 'pending') {
    await sendConfirmEmail(ctx, created);
    return { status: 'pending', message: '確認信已寄出，請到信箱點確認連結。', subscriber: created };
  }
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

  await ctx.store.updateSubscriber(subscriber.id, {
    status: 'subscribed',
    confirmedAt: nowIso(),
    unsubscribedAt: undefined,
  });
  return { ok: true, message: '訂閱完成，之後的電子報會寄到這個信箱。' };
}

export async function unsubscribeByToken(
  ctx: ServiceContext,
  token: string,
): Promise<{ ok: boolean; message: string }> {
  const verified = verifyToken(ctx.config.appSecret, token, 'unsubscribe');
  if (!verified) return { ok: false, message: '這個退訂連結無效。' };
  return unsubscribeByEmail(ctx, verified.email);
}

export async function unsubscribeByEmail(
  ctx: ServiceContext,
  email: string,
): Promise<{ ok: boolean; message: string }> {
  const subscriber = await ctx.store.getSubscriberByEmail(email.toLowerCase());
  if (!subscriber) return { ok: true, message: '這個地址不在名單內。' };
  if (subscriber.status === 'unsubscribed') return { ok: true, message: '你已經退訂了。' };
  await ctx.store.updateSubscriber(subscriber.id, {
    status: 'unsubscribed',
    unsubscribedAt: nowIso(),
  });
  return { ok: true, message: '已退訂，不會再收到電子報。' };
}

// ── 後台操作 ────────────────────────────────────────────────

export interface AdminSubscriberInput {
  email: unknown;
  name?: unknown;
  tags?: unknown;
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
export async function createSubscriber(
  ctx: ServiceContext,
  input: AdminSubscriberInput,
): Promise<Subscriber> {
  const email = normalizeEmail(input.email);
  const status = parseStatus(input.status, 'subscribed');
  return ctx.store.createSubscriber({
    id: newId('sub'),
    email,
    name: optionalString(input.name, '名稱', 120),
    status,
    tags: normalizeTags(input.tags),
    source: optionalString(input.source, '來源', 120) ?? 'admin',
    createdAt: nowIso(),
    confirmedAt: status === 'subscribed' ? nowIso() : undefined,
  });
}

export async function updateSubscriber(
  ctx: ServiceContext,
  id: string,
  input: Partial<AdminSubscriberInput>,
): Promise<Subscriber> {
  const current = await ctx.store.getSubscriber(id);
  if (!current) throw notFound('找不到這位訂閱者');

  const patch: Partial<Subscriber> = {};
  if (input.email !== undefined) patch.email = normalizeEmail(input.email);
  if (input.name !== undefined) patch.name = optionalString(input.name, '名稱', 120);
  if (input.tags !== undefined) patch.tags = normalizeTags(input.tags);
  if (input.status !== undefined) {
    const status = parseStatus(input.status, current.status);
    patch.status = status;
    if (status === 'subscribed' && !current.confirmedAt) patch.confirmedAt = nowIso();
    if (status === 'unsubscribed') patch.unsubscribedAt = nowIso();
  }
  const updated = await ctx.store.updateSubscriber(id, patch);
  if (!updated) throw notFound('找不到這位訂閱者');
  return updated;
}

export async function deleteSubscriber(ctx: ServiceContext, id: string): Promise<void> {
  const deleted = await ctx.store.deleteSubscriber(id);
  if (!deleted) throw notFound('找不到這位訂閱者');
}

export function listSubscribers(
  ctx: ServiceContext,
  query: SubscriberQuery,
): Promise<Paged<Subscriber>> {
  return ctx.store.listSubscribers(query);
}

export interface ImportResult {
  created: number;
  updated: number;
  skipped: number;
  errors: string[];
}

/**
 * CSV 匯入。第一列若含 email 欄名就當表頭，否則視為無表頭、第一欄是 email。
 * 支援欄位：email、name、tags（用 `|` 或 `;` 分隔）、status。
 */
export async function importSubscribersCsv(
  ctx: ServiceContext,
  csvText: string,
  defaultTags: string[] = [],
): Promise<ImportResult> {
  const rows = parseCsv(csvText);
  if (rows.length === 0) throw badRequest('CSV 沒有可匯入的資料');

  const first = rows[0]!.map((cell) => cell.trim().toLowerCase());
  const hasHeader = first.includes('email');
  const header = hasHeader ? first : ['email', 'name', 'tags', 'status'];
  const dataRows = hasHeader ? rows.slice(1) : rows;
  const columnOf = (field: string): number => header.indexOf(field);

  const result: ImportResult = { created: 0, updated: 0, skipped: 0, errors: [] };

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
    const name = nameCol >= 0 ? (row[nameCol]?.trim() || undefined) : undefined;
    const rowTags = tagsCol >= 0 ? (row[tagsCol] ?? '').split(/[|;]/) : [];
    const tags = normalizeTags([...defaultTags, ...rowTags]);
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
      await ctx.store.updateSubscriber(existing.id, {
        name: name ?? existing.name,
        tags: [...new Set([...existing.tags, ...tags])],
      });
      result.updated += 1;
      continue;
    }
    await ctx.store.createSubscriber({
      id: newId('sub'),
      email,
      name,
      status,
      tags,
      source: 'import',
      createdAt: nowIso(),
      confirmedAt: status === 'subscribed' ? nowIso() : undefined,
    });
    result.created += 1;
  }

  return result;
}

export async function exportSubscribersCsv(ctx: ServiceContext): Promise<string> {
  const all: Subscriber[] = [];
  const pageSize = 500;
  for (let offset = 0; ; offset += pageSize) {
    const page = await ctx.store.listSubscribers({ limit: pageSize, offset });
    all.push(...page.items);
    if (all.length >= page.total || page.items.length === 0) break;
  }
  return toCsv(
    ['email', 'name', 'status', 'tags', 'source', 'created_at', 'confirmed_at', 'unsubscribed_at'],
    all.map((s) => [
      s.email,
      s.name ?? '',
      s.status,
      s.tags.join('|'),
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

import { hmacSha256Hex, safeEqualHex } from '../core/tokens.js';
import { badRequest } from '../core/errors.js';
import { normalizeEmail, normalizeTags, optionalString } from '../core/validate.js';
import type { Subscriber } from '../store/types.js';
import type { ServiceContext } from './context.js';
import { enrollSubscriber } from './enroll.js';
import { createSubscriber } from './subscribers.js';

export function verifyIngestSignature(
  secret: string | undefined,
  rawBody: string,
  header: string | undefined,
): boolean {
  if (!secret) return false;
  const provided = (header ?? '').replace(/^sha256=/i, '').trim();
  if (!provided) return false;
  return safeEqualHex(provided, hmacSha256Hex(secret, rawBody));
}

export interface IngestInput {
  email: unknown;
  name?: unknown;
  tags?: unknown;
  source?: unknown;
  /** 預設 false：重複 email 只更新標籤，不重開確認信 */
  confirm?: unknown;
}

export interface IngestResult {
  action: 'created' | 'updated';
  subscriber: Subscriber;
}

/**
 * 簽名匯入：新 email 直接進名單（預設已訂閱，管理者／上游負責同意）。
 * 已存在則合併標籤與名稱。
 */
export async function ingestSubscriber(
  ctx: ServiceContext,
  input: IngestInput,
): Promise<IngestResult> {
  const email = normalizeEmail(input.email);
  const name = optionalString(input.name, '名稱', 120);
  const tags = normalizeTags(input.tags);
  const source = optionalString(input.source, '來源', 120) ?? 'ingest';
  const existing = await ctx.store.getSubscriberByEmail(email);

  if (existing) {
    const merged = [...new Set([...existing.tags, ...tags])];
    const added = merged.filter((t) => !existing.tags.includes(t));
    const updated = (await ctx.store.updateSubscriber(existing.id, {
      name: name ?? existing.name,
      tags: merged,
      source: existing.source ?? source,
    }))!;
    if (added.length > 0) await enrollSubscriber(ctx, updated, { type: 'tag', tags: added });
    return { action: 'updated', subscriber: updated };
  }

  const created = await createSubscriber(ctx, {
    email,
    name,
    tags,
    status: 'subscribed',
    source,
  });
  await enrollSubscriber(ctx, created, { type: 'subscribe' });
  if (tags.length > 0) await enrollSubscriber(ctx, created, { type: 'tag', tags });
  return { action: 'created', subscriber: created };
}

export async function ingestEvent(
  ctx: ServiceContext,
  input: { email: unknown; event: unknown; tags?: unknown },
): Promise<{ ok: true; enrolled: number; subscriber: Subscriber | null }> {
  const email = normalizeEmail(input.email);
  const event = optionalString(input.event, '事件', 80);
  if (!event) throw badRequest('請提供 event');
  const tags = normalizeTags(input.tags);
  let subscriber = await ctx.store.getSubscriberByEmail(email);
  if (!subscriber) {
    subscriber = await createSubscriber(ctx, {
      email,
      tags,
      status: 'subscribed',
      source: `event:${event}`,
    });
  } else if (tags.length > 0) {
    const merged = [...new Set([...subscriber.tags, ...tags])];
    subscriber = (await ctx.store.updateSubscriber(subscriber.id, { tags: merged }))!;
  }
  let enrolled = await enrollSubscriber(ctx, subscriber, { type: 'event', event });
  if (tags.length > 0) {
    enrolled += await enrollSubscriber(ctx, subscriber, { type: 'tag', tags });
  }
  return { ok: true, enrolled, subscriber };
}

export function requireIngestSecret(ctx: ServiceContext): string {
  const secret = ctx.config.ingestSecret;
  if (!secret) throw badRequest('尚未設定 INGEST_SECRET，無法接收匯入 webhook');
  return secret;
}

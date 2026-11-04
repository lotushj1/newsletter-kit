import { logger } from '../core/logger.js';
import type { SubscriberStatus } from '../store/types.js';

/**
 * 訂閱／退訂即時同步到 Notion「電子報訂閱會員」資料庫。
 * - 依 email 找列：有就更新「狀態」，沒有就新建（email / 狀態 / 來源 / 訂閱日）。
 * - 背景執行：失敗只記 log，絕不擋住訂閱或退訂流程。
 * - 沒設 NOTION_TOKEN 或 NOTION_SUBSCRIBERS_DB_ID 時完全不做事。
 */

export const NOTION_SUBSCRIBED = '訂閱中';
export const NOTION_UNSUBSCRIBED = '已退訂';
const NOTION_SOURCE = 'newsletter-kit';
const NOTION_VERSION = '2022-06-28';
const TIMEOUT_MS = 8000;

/** 只有確認訂閱才算訂閱中；退訂、退信、尚未 opt-in 都記為已退訂。 */
export function notionStatusFor(status: SubscriberStatus): string {
  return status === 'subscribed' ? NOTION_SUBSCRIBED : NOTION_UNSUBSCRIBED;
}

type FetchLike = typeof fetch;

interface NotionEnv {
  token: string;
  databaseId: string;
}

function readEnv(): NotionEnv | null {
  const token = process.env.NOTION_TOKEN?.trim();
  const databaseId = process.env.NOTION_SUBSCRIBERS_DB_ID?.trim();
  if (!token || !databaseId) return null;
  return { token, databaseId };
}

async function notion(
  env: NotionEnv,
  fetchImpl: FetchLike,
  path: string,
  method: 'POST' | 'PATCH',
  body: unknown,
): Promise<any> {
  const res = await fetchImpl(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Notion ${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
}

/** 直接執行同步（測試用；正式流程請用 syncSubscriberToNotion）。 */
export async function upsertNotionSubscriber(
  email: string,
  status: SubscriberStatus,
  fetchImpl: FetchLike = fetch,
): Promise<'created' | 'updated' | 'skipped'> {
  const env = readEnv();
  if (!env) return 'skipped';
  const normalized = email.trim().toLowerCase();
  const statusName = notionStatusFor(status);
  const query = await notion(env, fetchImpl, `/databases/${env.databaseId}/query`, 'POST', {
    filter: { property: 'email', title: { equals: normalized } },
    page_size: 1,
  });
  const page = query?.results?.[0];
  if (page?.id) {
    await notion(env, fetchImpl, `/pages/${page.id}`, 'PATCH', {
      properties: { 狀態: { select: { name: statusName } } },
    });
    return 'updated';
  }
  await notion(env, fetchImpl, '/pages', 'POST', {
    parent: { database_id: env.databaseId },
    properties: {
      email: { title: [{ text: { content: normalized } }] },
      狀態: { select: { name: statusName } },
      來源: { multi_select: [{ name: NOTION_SOURCE }] },
      訂閱日: { date: { start: new Date().toISOString().slice(0, 10) } },
    },
  });
  return 'created';
}

const pending = new Set<Promise<unknown>>();

/** 測試用：等所有背景同步跑完。 */
export async function flushNotionSync(): Promise<void> {
  await Promise.allSettled([...pending]);
}

function keepAlive(promise: Promise<unknown>): void {
  // Vercel 函式回應後仍讓背景工作跑完（同 @vercel/functions 的 waitUntil）。
  const ctx = (globalThis as any)[Symbol.for('@vercel/request-context')]?.get?.();
  if (typeof ctx?.waitUntil === 'function') ctx.waitUntil(promise);
}

/** 背景同步，不 await、不丟錯。 */
export function syncSubscriberToNotion(email: string, status: SubscriberStatus): void {
  if (!readEnv()) return;
  const job = upsertNotionSubscriber(email, status)
    .then((action) => logger.info('Notion 同步完成', { email, status, action }))
    .catch((error: unknown) =>
      logger.error('Notion 同步失敗', { email, status, error: error instanceof Error ? error.message : String(error) }),
    )
    .finally(() => pending.delete(job));
  pending.add(job);
  keepAlive(job);
}

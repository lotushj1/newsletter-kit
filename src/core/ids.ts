import { randomUUID } from 'node:crypto';

export const newId = (prefix: string): string => `${prefix}_${randomUUID().replace(/-/g, '')}`;

export const nowIso = (): string => new Date().toISOString();

/** 把標題轉成網址片段；中文等非 ASCII 字元保留，只清掉路徑不安全的符號。 */
export function slugify(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/['"“”‘’]/g, '')
    .replace(/[\s\u3000]+/g, '-')
    .replace(/[^\p{Letter}\p{Number}\-_]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
  return slug || `untitled-${Date.now().toString(36)}`;
}

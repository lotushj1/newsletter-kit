import { badRequest } from './errors.js';

const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[a-z]{2,}$/i;

export function isEmail(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 254 && EMAIL_RE.test(value.trim());
}

export function normalizeEmail(value: unknown): string {
  if (!isEmail(value)) throw badRequest('Email 格式不正確');
  return (value as string).trim().toLowerCase();
}

export function requireString(value: unknown, field: string, max = 500): string {
  if (typeof value !== 'string' || value.trim() === '') throw badRequest(`${field} 不可空白`);
  if (value.length > max) throw badRequest(`${field} 太長（上限 ${max} 字）`);
  return value.trim();
}

export function optionalString(value: unknown, field: string, max = 500): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return requireString(value, field, max);
}

export function normalizeTags(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];
  const tags = raw
    .map((t) => String(t).trim().toLowerCase())
    .filter((t) => t !== '' && t.length <= 50);
  return [...new Set(tags)].slice(0, 20);
}

export function parseIsoDate(value: unknown, field: string): string {
  const raw = requireString(value, field, 64);
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) throw badRequest(`${field} 不是有效時間格式`);
  return date.toISOString();
}

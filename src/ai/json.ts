import { badRequest } from '../core/errors.js';

export function parseModelJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    throw badRequest('AI 回傳的不是 JSON');
  }
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest('AI 回傳的格式無法使用');
  }
  return value as Record<string, unknown>;
}

export function cleanHtml(value: unknown, field: string, max = 20_000): string {
  if (typeof value !== 'string' || value.trim() === '') throw badRequest(`${field} 不可空白`);
  const html = value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/\son\w+\s*=\s*(['"]).*?\1/gi, '')
    .trim();
  if (!html) throw badRequest(`${field} 不可空白`);
  if (html.length > max) throw badRequest(`${field} 太長`);
  if (!html.includes('<')) {
    return html
      .split(/\n{2,}/)
      .map((part) => `<p>${escapeHtml(part).replace(/\n/g, '<br>')}</p>`)
      .join('');
  }
  return html;
}

export function ensureSignature(html: string): string {
  if (html.includes('{{signature}}')) return html;
  return `${html}<p>{{signature}}</p>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

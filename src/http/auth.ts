import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Config } from '../config.js';
import { unauthorized } from '../core/errors.js';

export const ADMIN_COOKIE = 'nk_admin';
export const ADMIN_SESSION_AGE_SECONDS = 60 * 60 * 24 * 14;

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export function extractToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  return readCookie(req, ADMIN_COOKIE);
}

export function isAuthorized(config: Config, req: Request): boolean {
  const bearer = req.headers.authorization;
  if (bearer?.startsWith('Bearer ')) return safeEqual(bearer.slice(7).trim(), config.adminToken);
  const cookie = readCookie(req, ADMIN_COOKIE);
  if (!cookie) return false;
  if (safeEqual(cookie, config.adminToken)) return true;
  if (!isGoogleConfigured(config)) return false;
  const payload = verifySignedValue(config.appSecret, cookie);
  if (!isRecord(payload) || payload.kind !== 'google') return false;
  if (typeof payload.email !== 'string' || typeof payload.issuedAt !== 'number' || typeof payload.expiresAt !== 'number') return false;
  const now = Math.floor(Date.now() / 1000);
  return payload.issuedAt <= now + 60 && payload.issuedAt < payload.expiresAt &&
    payload.expiresAt > now &&
    payload.expiresAt - payload.issuedAt <= ADMIN_SESSION_AGE_SECONDS &&
    isGoogleEmailAllowed(config, payload.email);
}

export function isGoogleConfigured(config: Config): boolean {
  return Boolean(config.google.clientId && config.google.clientSecret &&
    config.google.adminEmails.some((email) => email.trim()));
}

export function isGoogleEmailAllowed(config: Config, email: string): boolean {
  const normalized = email.trim().toLowerCase();
  return config.google.adminEmails.some((allowed) => allowed.trim().toLowerCase() === normalized);
}

export function sanitizeAdminNext(next: string | undefined): string {
  if (!next || Buffer.byteLength(next, 'utf8') > 1024 || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\') ||
      next.includes('\\') || /[\u0000-\u001f\u007f]/.test(next)) return '/admin';
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** APP_SECRET 簽章的短 payload；kind 由各使用端驗證，避免不同用途混用。 */
export function signValue(secret: string, payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const input = `v1.${body}`;
  const signature = createHmac('sha256', secret).update(input).digest('base64url');
  return `${input}.${signature}`;
}

export function verifySignedValue(secret: string, value: string): unknown | null {
  if (value.length > 8192) return null;
  const parts = value.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1' || !parts[1] || !parts[2]) return null;
  const input = `${parts[0]}.${parts[1]}`;
  const expected = createHmac('sha256', secret).update(input).digest('base64url');
  if (!safeEqual(parts[2], expected)) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as unknown;
  } catch {
    return null;
  }
}

export function createGoogleAdminSession(config: Config, email: string): string {
  const now = Math.floor(Date.now() / 1000);
  return signValue(config.appSecret, {
    kind: 'google',
    email: email.trim().toLowerCase(),
    issuedAt: now,
    expiresAt: now + ADMIN_SESSION_AGE_SECONDS,
  });
}

/** API 用：未授權回 401 JSON。 */
export function requireAdmin(config: Config) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!isAuthorized(config, req)) {
      next(unauthorized('後台需要登入'));
      return;
    }
    next();
  };
}

/** 頁面用：未授權導回登入頁。 */
export function requireAdminPage(config: Config) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!isAuthorized(config, req)) {
      res.redirect(`/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
      return;
    }
    next();
  };
}

export function setAdminCookie(res: Response, token: string, secure: boolean): void {
  const parts = [
    `${ADMIN_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${ADMIN_SESSION_AGE_SECONDS}`,
  ];
  if (secure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

export function clearAdminCookie(res: Response): void {
  res.append('Set-Cookie', `${ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Config } from '../config.js';
import { unauthorized } from '../core/errors.js';

export const ADMIN_COOKIE = 'nk_admin';

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
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

export function extractToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  return readCookie(req, ADMIN_COOKIE);
}

export function isAuthorized(config: Config, req: Request): boolean {
  const token = extractToken(req);
  return typeof token === 'string' && safeEqual(token, config.adminToken);
}

/** API 用：未授權回 401 JSON。 */
export function requireAdmin(config: Config) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!isAuthorized(config, req)) {
      next(unauthorized('後台需要 ADMIN_TOKEN'));
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
    `Max-Age=${60 * 60 * 24 * 14}`,
  ];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function clearAdminCookie(res: Response): void {
  res.setHeader('Set-Cookie', `${ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

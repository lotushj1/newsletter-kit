import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { tooMany } from '../core/errors.js';

/** 包住 async handler，讓丟出的錯誤走 express 錯誤中介層。 */
export const asyncRoute =
  (handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    handler(req, res, next).catch(next);
  };

/** Express 5 的 req.params 型別可能是陣列，統一收斂成字串。 */
export function pathParam(req: Request, name: string): string {
  const value = (req.params as Record<string, string | string[] | undefined>)[name];
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

export function intParam(value: unknown, fallback: number, max = 500): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

/** 記憶體版速率限制，只擋單一程序內的濫用。要更嚴謹請放反向代理層。 */
export function rateLimit(perMinute: number): RequestHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req, _res, next) => {
    if (perMinute <= 0) {
      next();
      return;
    }
    const key = req.ip ?? 'unknown';
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + 60_000 });
      if (hits.size > 5000) {
        for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
      }
      next();
      return;
    }
    entry.count += 1;
    if (entry.count > perMinute) {
      next(tooMany());
      return;
    }
    next();
  };
}

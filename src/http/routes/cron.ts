import { timingSafeEqual } from 'node:crypto';
import { Router, type Request } from 'express';
import type { ServiceContext } from '../../services/context.js';
import { createScheduler } from '../../services/scheduler.js';
import { asyncRoute } from '../helpers.js';

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function authorized(secret: string, req: Request): boolean {
  const header = req.headers.authorization;
  return typeof header === 'string' && header.startsWith('Bearer ') && safeEqual(header.slice(7).trim(), secret);
}

/**
 * serverless（Vercel）沒有長駐程序，setInterval 排程器不會跑，
 * 改由外部 cron（Vercel Cron／GitHub Actions）定時打這個端點跑一次 tick。
 * Vercel Cron 會自動帶 `Authorization: Bearer $CRON_SECRET`。
 */
export function cronRouter(ctx: ServiceContext): Router {
  const router = Router();
  const scheduler = createScheduler(ctx);
  const handler = asyncRoute(async (req, res) => {
    const secret = ctx.config.scheduler.cronSecret;
    if (!secret) {
      res.status(503).json({ error: '尚未設定 CRON_SECRET' });
      return;
    }
    if (!authorized(secret, req)) {
      res.status(401).json({ error: '未授權' });
      return;
    }
    const summary = await scheduler.tick();
    res.json({ ok: !summary.error, at: new Date().toISOString(), ...summary });
  });
  router.get('/tick', handler);
  router.post('/tick', handler);
  return router;
}

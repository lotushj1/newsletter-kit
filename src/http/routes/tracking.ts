import { Router } from 'express';
import { TRANSPARENT_GIF } from '../../core/tracking.js';
import type { ServiceContext } from '../../services/context.js';
import { recordClick, recordOpen } from '../../services/tracking.js';
import { asyncRoute } from '../helpers.js';

export function trackingRouter(ctx: ServiceContext): Router {
  const router = Router();

  router.get(
    '/t/open',
    asyncRoute(async (req, res) => {
      if (ctx.config.trackingEnabled) {
        await recordOpen(ctx, String(req.query.token ?? ''));
      }
      res.setHeader('cache-control', 'no-store, no-cache, must-revalidate, private');
      res.type('gif').send(TRANSPARENT_GIF);
    }),
  );

  router.get(
    '/t/click',
    asyncRoute(async (req, res) => {
      const url = ctx.config.trackingEnabled
        ? await recordClick(ctx, String(req.query.token ?? ''))
        : null;
      if (!url) {
        res.status(400).type('html').send('<p>這個連結無效或已過期。</p>');
        return;
      }
      res.redirect(302, url);
    }),
  );

  return router;
}

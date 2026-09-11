import { Router } from 'express';
import { verifyToken } from '../../core/tokens.js';
import { publicSubject, renderPublicCampaign } from '../../services/campaigns.js';
import type { ServiceContext } from '../../services/context.js';
import {
  confirmSubscription,
  subscribe,
  unsubscribeByToken,
} from '../../services/subscribers.js';
import {
  confirmResultPage,
  unsubscribeConfirmPage,
  unsubscribeResultPage,
} from '../views/pages.js';
import { asyncRoute, intParam, pathParam, rateLimit } from '../helpers.js';

export function publicRouter(ctx: ServiceContext): Router {
  const router = Router();
  const limiter = rateLimit(ctx.config.publicRateLimitPerMin);

  router.get('/health', (_req, res) => {
    res.json({ ok: true, provider: ctx.adapter.name, store: ctx.store.driver });
  });

  /** 官網訂閱表單打這支。 */
  router.post(
    '/api/public/subscribe',
    limiter,
    asyncRoute(async (req, res) => {
      const outcome = await subscribe(ctx, req.body ?? {});
      res.status(outcome.status === 'already_subscribed' ? 200 : 201).json({
        ok: true,
        status: outcome.status,
        message: outcome.message,
      });
    }),
  );

  /** 一鍵退訂（List-Unsubscribe-Post）與程式化退訂。 */
  router.post(
    '/api/public/unsubscribe',
    limiter,
    asyncRoute(async (req, res) => {
      const token = String(req.body?.token ?? req.query.token ?? '');
      const result = await unsubscribeByToken(ctx, token);
      res.status(result.ok ? 200 : 400).json(result);
    }),
  );

  /** 已寄出電子報的封存清單，官網可以直接拿去做列表頁。 */
  router.get(
    '/api/public/campaigns',
    asyncRoute(async (req, res) => {
      const result = await ctx.store.listCampaigns({
        status: 'sent',
        limit: intParam(req.query.limit, 20, 100),
        offset: intParam(req.query.offset, 0, 1_000_000),
      });
      res.json({
        total: result.total,
        items: result.items.map((c) => ({
          slug: c.slug,
          title: c.title,
          subject: publicSubject(ctx, c),
          preheader: c.preheader ?? null,
          sentAt: c.sentAt ?? null,
        })),
      });
    }),
  );

  router.get(
    '/api/public/campaigns/:slug',
    asyncRoute(async (req, res) => {
      const found = await renderPublicCampaign(ctx, pathParam(req, 'slug'));
      if (!found) {
        res.status(404).json({ error: '找不到這份電子報' });
        return;
      }
      res.json({
        slug: found.campaign.slug,
        title: found.campaign.title,
        subject: found.subject,
        sentAt: found.campaign.sentAt ?? null,
        html: found.html,
      });
    }),
  );

  router.get(
    '/confirm',
    asyncRoute(async (req, res) => {
      const result = await confirmSubscription(ctx, String(req.query.token ?? ''));
      res
        .status(result.ok ? 200 : 400)
        .type('html')
        .send(confirmResultPage(ctx.config.siteName, result.ok, result.message));
    }),
  );

  /** GET 只顯示確認頁，實際退訂走 POST，避免信箱掃描器誤觸。 */
  router.get(
    '/unsubscribe',
    asyncRoute(async (req, res) => {
      const token = String(req.query.token ?? '');
      const verified = verifyToken(ctx.config.appSecret, token, 'unsubscribe');
      if (!verified) {
        res
          .status(400)
          .type('html')
          .send(unsubscribeResultPage(ctx.config.siteName, '這個退訂連結無效。'));
        return;
      }
      res.type('html').send(unsubscribeConfirmPage(ctx.config.siteName, token, verified.email));
    }),
  );

  router.post(
    '/unsubscribe',
    asyncRoute(async (req, res) => {
      const result = await unsubscribeByToken(ctx, String(req.body?.token ?? ''));
      res
        .status(result.ok ? 200 : 400)
        .type('html')
        .send(unsubscribeResultPage(ctx.config.siteName, result.message));
    }),
  );

  return router;
}

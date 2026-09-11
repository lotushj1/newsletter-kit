import { Router } from 'express';
import { listEmailAdapters } from '../../email/registry.js';
import { createCampaign, getCampaign, listCampaigns } from '../../services/campaigns.js';
import type { ServiceContext } from '../../services/context.js';
import { listSubscribers } from '../../services/subscribers.js';
import type { SubscriberStatus } from '../../store/types.js';
import {
  clearAdminCookie,
  isAuthorized,
  requireAdminPage,
  setAdminCookie,
} from '../auth.js';
import { asyncRoute, intParam, pathParam } from '../helpers.js';
import {
  campaignEditPage,
  campaignsPage,
  dashboardPage,
  loginPage,
  settingsPage,
  subscribersPage,
} from '../views/pages.js';

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

/** 收集名單裡出現過的標籤，給編輯頁當提示。 */
async function collectTags(ctx: ServiceContext): Promise<string[]> {
  const page = await ctx.store.listSubscribers({ limit: 500 });
  return [...new Set(page.items.flatMap((s) => s.tags))].sort().slice(0, 30);
}

export function adminUiRouter(ctx: ServiceContext): Router {
  const router = Router();
  const { siteName } = ctx.config;

  router.get('/login', (req, res) => {
    if (isAuthorized(ctx.config, req)) {
      res.redirect('/admin');
      return;
    }
    res.type('html').send(loginPage(siteName, { next: str(req.query.next) ?? '/admin' }));
  });

  router.post('/login', (req, res) => {
    const token = String(req.body?.token ?? '');
    const next = String(req.body?.next ?? '/admin');
    if (token !== ctx.config.adminToken) {
      res
        .status(401)
        .type('html')
        .send(loginPage(siteName, { error: 'Token 不正確。', next }));
      return;
    }
    setAdminCookie(res, token, ctx.config.publicBaseUrl.startsWith('https://'));
    res.redirect(next.startsWith('/') ? next : '/admin');
  });

  router.post('/logout', (_req, res) => {
    clearAdminCookie(res);
    res.redirect('/admin/login');
  });

  router.use(requireAdminPage(ctx.config));

  router.get(
    '/',
    asyncRoute(async (_req, res) => {
      const [counts, recent, verify] = await Promise.all([
        ctx.store.countSubscribersByStatus(),
        listCampaigns(ctx, { limit: 8 }),
        ctx.adapter.verify(),
      ]);
      res.type('html').send(
        dashboardPage(siteName, {
          counts,
          recent: recent.items,
          provider: ctx.adapter.name,
          providerOk: verify.ok,
          providerMessage: verify.message,
          warnings: ctx.config.warnings,
        }),
      );
    }),
  );

  router.get(
    '/campaigns',
    asyncRoute(async (_req, res) => {
      const result = await listCampaigns(ctx, { limit: 100 });
      res.type('html').send(campaignsPage(siteName, result.items));
    }),
  );

  router.post(
    '/campaigns',
    asyncRoute(async (_req, res) => {
      const created = await createCampaign(ctx, {
        title: `未命名電子報 ${new Date().toLocaleDateString('zh-TW')}`,
        bodyMarkdown: '嗨 {{name}}，\n\n這裡是這期的內容。\n',
      });
      res.redirect(`/admin/campaigns/${created.id}`);
    }),
  );

  router.get(
    '/campaigns/:id',
    asyncRoute(async (req, res) => {
      const campaign = await getCampaign(ctx, pathParam(req, 'id'));
      const [audience, tags] = await Promise.all([
        ctx.store.listAudience(campaign.audienceTags),
        collectTags(ctx),
      ]);
      res.type('html').send(campaignEditPage(siteName, campaign, audience.length, tags));
    }),
  );

  router.get(
    '/subscribers',
    asyncRoute(async (req, res) => {
      const query = {
        status: str(req.query.status) as SubscriberStatus | undefined,
        tag: str(req.query.tag),
        search: str(req.query.search),
        limit: intParam(req.query.limit, 100),
        offset: intParam(req.query.offset, 0, 1_000_000),
      };
      const [result, counts] = await Promise.all([
        listSubscribers(ctx, query),
        ctx.store.countSubscribersByStatus(),
      ]);
      res.type('html').send(subscribersPage(siteName, result, query, counts));
    }),
  );

  router.get('/settings', (_req, res) => {
    res.type('html').send(
      settingsPage(siteName, {
        provider: ctx.adapter.name,
        availableProviders: listEmailAdapters(),
        from: ctx.config.email.from,
        replyTo: ctx.config.email.replyTo,
        publicBaseUrl: ctx.config.publicBaseUrl,
        storeDriver: ctx.store.driver,
        doubleOptIn: ctx.config.doubleOptIn,
        corsOrigins: ctx.config.corsOrigins,
        schedulerEnabled: ctx.config.scheduler.enabled,
        batchSize: ctx.config.send.batchSize,
        warnings: ctx.config.warnings,
      }),
    );
  });

  return router;
}

import { Router } from 'express';
import { badRequest } from '../../core/errors.js';
import { normalizeEmail, normalizeTags } from '../../core/validate.js';
import { listEmailAdapters } from '../../email/registry.js';
import {
  createCampaign,
  deleteCampaign,
  getCampaign,
  listCampaigns,
  renderCampaign,
  updateCampaign,
  scheduleCampaign,
  cancelSchedule,
  PREVIEW_RECIPIENT,
} from '../../services/campaigns.js';
import type { ServiceContext } from '../../services/context.js';
import { cancelSending, sendTestEmail, startCampaign } from '../../services/sending.js';
import {
  createSubscriber,
  deleteSubscriber,
  exportSubscribersCsv,
  importSubscribersCsv,
  listSubscribers,
  updateSubscriber,
} from '../../services/subscribers.js';
import type { Campaign, CampaignStatus, SubscriberStatus } from '../../store/types.js';
import { requireAdmin } from '../auth.js';
import { asyncRoute, intParam, pathParam } from '../helpers.js';

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

export function adminApiRouter(ctx: ServiceContext): Router {
  const router = Router();
  router.use(requireAdmin(ctx.config));

  router.get(
    '/overview',
    asyncRoute(async (_req, res) => {
      const counts = await ctx.store.countSubscribersByStatus();
      const recent = await listCampaigns(ctx, { limit: 10 });
      res.json({ counts, campaigns: recent.items, provider: ctx.adapter.name });
    }),
  );

  router.get(
    '/email/verify',
    asyncRoute(async (_req, res) => {
      const result = await ctx.adapter.verify();
      res.json({ ...result, provider: ctx.adapter.name, available: listEmailAdapters() });
    }),
  );

  // ── 訂閱者 ────────────────────────────────────────────────
  router.get(
    '/subscribers/export.csv',
    asyncRoute(async (_req, res) => {
      res.setHeader('content-type', 'text/csv; charset=utf-8');
      res.setHeader('content-disposition', 'attachment; filename="subscribers.csv"');
      res.send(await exportSubscribersCsv(ctx));
    }),
  );

  router.get(
    '/subscribers',
    asyncRoute(async (req, res) => {
      const result = await listSubscribers(ctx, {
        status: str(req.query.status) as SubscriberStatus | undefined,
        tag: str(req.query.tag),
        search: str(req.query.search),
        limit: intParam(req.query.limit, 50),
        offset: intParam(req.query.offset, 0, 1_000_000),
      });
      res.json(result);
    }),
  );

  router.post(
    '/subscribers',
    asyncRoute(async (req, res) => {
      res.status(201).json(await createSubscriber(ctx, req.body ?? {}));
    }),
  );

  router.patch(
    '/subscribers/:id',
    asyncRoute(async (req, res) => {
      res.json(await updateSubscriber(ctx, pathParam(req, 'id'), req.body ?? {}));
    }),
  );

  router.delete(
    '/subscribers/:id',
    asyncRoute(async (req, res) => {
      await deleteSubscriber(ctx, pathParam(req, 'id'));
      res.json({ ok: true });
    }),
  );

  router.post(
    '/subscribers/import',
    asyncRoute(async (req, res) => {
      const csv = req.body?.csv;
      if (typeof csv !== 'string' || csv.trim() === '') throw badRequest('請提供 CSV 內容');
      res.json(await importSubscribersCsv(ctx, csv, normalizeTags(req.body?.tags)));
    }),
  );

  // ── 電子報 ────────────────────────────────────────────────
  router.get(
    '/campaigns',
    asyncRoute(async (req, res) => {
      res.json(
        await listCampaigns(ctx, {
          status: str(req.query.status) as CampaignStatus | undefined,
          limit: intParam(req.query.limit, 50),
          offset: intParam(req.query.offset, 0, 1_000_000),
        }),
      );
    }),
  );

  router.post(
    '/campaigns',
    asyncRoute(async (req, res) => {
      res.status(201).json(await createCampaign(ctx, req.body ?? {}));
    }),
  );

  router.get(
    '/campaigns/:id',
    asyncRoute(async (req, res) => {
      res.json(await getCampaign(ctx, pathParam(req, 'id')));
    }),
  );

  router.patch(
    '/campaigns/:id',
    asyncRoute(async (req, res) => {
      res.json(await updateCampaign(ctx, pathParam(req, 'id'), req.body ?? {}));
    }),
  );

  router.delete(
    '/campaigns/:id',
    asyncRoute(async (req, res) => {
      await deleteCampaign(ctx, pathParam(req, 'id'));
      res.json({ ok: true });
    }),
  );

  /** 預覽可以吃「還沒存檔」的草稿內容，方便邊寫邊看。 */
  router.post(
    '/campaigns/:id/preview',
    asyncRoute(async (req, res) => {
      const saved = await getCampaign(ctx, pathParam(req, 'id'));
      const body = req.body ?? {};
      const draft: Campaign = {
        ...saved,
        subject: typeof body.subject === 'string' && body.subject ? body.subject : saved.subject,
        preheader: typeof body.preheader === 'string' ? body.preheader : saved.preheader,
        bodyMarkdown:
          typeof body.bodyMarkdown === 'string' ? body.bodyMarkdown : saved.bodyMarkdown,
        audienceTags:
          body.audienceTags === undefined ? saved.audienceTags : normalizeTags(body.audienceTags),
      };
      const rendered = renderCampaign(ctx, draft, PREVIEW_RECIPIENT);
      const audience = await ctx.store.listAudience(draft.audienceTags);
      res.json({ ...rendered, audienceCount: audience.length });
    }),
  );

  router.post(
    '/campaigns/:id/test',
    asyncRoute(async (req, res) => {
      const email = normalizeEmail(req.body?.email);
      const result = await sendTestEmail(ctx, pathParam(req, 'id'), email);
      if (!result.ok) throw badRequest(result.message);
      res.json(result);
    }),
  );

  router.post(
    '/campaigns/:id/schedule',
    asyncRoute(async (req, res) => {
      res.json(await scheduleCampaign(ctx, pathParam(req, 'id'), req.body?.scheduledAt));
    }),
  );

  router.post(
    '/campaigns/:id/unschedule',
    asyncRoute(async (req, res) => {
      res.json(await cancelSchedule(ctx, pathParam(req, 'id')));
    }),
  );

  router.post(
    '/campaigns/:id/send',
    asyncRoute(async (req, res) => {
      const result = await startCampaign(ctx, pathParam(req, 'id'), { background: true });
      res.json({ ok: true, total: result.total });
    }),
  );

  router.post(
    '/campaigns/:id/cancel',
    asyncRoute(async (req, res) => {
      res.json(await cancelSending(ctx, pathParam(req, 'id')));
    }),
  );

  router.get(
    '/campaigns/:id/deliveries',
    asyncRoute(async (req, res) => {
      const deliveries = await ctx.store.listDeliveries(pathParam(req, 'id'), {
        limit: intParam(req.query.limit, 200, 2000),
      });
      res.json({ items: deliveries, stats: await ctx.store.deliveryStats(pathParam(req, 'id')) });
    }),
  );

  return router;
}

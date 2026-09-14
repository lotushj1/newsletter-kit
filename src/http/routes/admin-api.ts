import { Router } from 'express';
import { badRequest } from '../../core/errors.js';
import { saveCampaignImage } from '../../core/uploads.js';
import { decodeImportFile, spreadsheetToCsv } from '../../core/spreadsheet.js';
import { normalizeEmail, normalizeTags } from '../../core/validate.js';
import { listEmailAdapters } from '../../email/registry.js';
import {
  bulkDeleteCampaigns,
  bulkSetCampaignFolder,
  createCampaign,
  deleteCampaign,
  getCampaign,
  listCampaigns,
  overviewRates,
  renderCampaign,
  updateCampaign,
  scheduleCampaign,
  cancelSchedule,
  PREVIEW_RECIPIENT,
} from '../../services/campaigns.js';
import type { ServiceContext } from '../../services/context.js';
import {
  createSequence,
  deleteSequence,
  getSequenceWithSteps,
  listSequencesWithSteps,
  updateSequence,
} from '../../services/sequences.js';
import { cancelSending, sendTestEmail, startCampaign } from '../../services/sending.js';
import {
  createFolder,
  deleteFolder,
  listFolders,
  updateFolder,
} from '../../services/folders.js';
import { getBrand, updateBrand } from '../../services/brand.js';
import {
  createTemplate,
  deleteTemplate,
  listTemplates,
  updateTemplate,
} from '../../services/templates.js';
import {
  copyCampaignStarter,
  createCampaignStarter,
  createCampaignStarterFromCampaign,
  deleteCampaignStarter,
  getCampaignStarter,
  listCampaignStarters,
  updateCampaignStarter,
} from '../../services/starters.js';
import {
  createSubscriber,
  deleteSubscriber,
  exportSubscribersCsv,
  importSubscribersCsv,
  listSubscribers,
  listSubscriberTags,
  updateSubscriber,
} from '../../services/subscribers.js';
import { audienceFromCampaign, type Campaign, type CampaignStatus, type SubscriberStatus } from '../../store/types.js';
import { requireAdmin } from '../auth.js';
import { asyncRoute, intParam, pathParam } from '../helpers.js';

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

export function adminApiRouter(ctx: ServiceContext): Router {
  const router = Router();
  router.use(requireAdmin(ctx.config));

  router.get('/session', (_req, res) => {
    res.json({
      siteName: ctx.config.siteName,
      provider: ctx.adapter.name,
      storeDriver: ctx.store.driver,
      publicBaseUrl: ctx.config.publicBaseUrl,
      from: ctx.config.email.from,
      replyTo: ctx.config.email.replyTo ?? null,
      doubleOptIn: ctx.config.doubleOptIn,
      trackingEnabled: ctx.config.trackingEnabled,
      joinUrl: `${ctx.config.publicBaseUrl}/join`,
      archiveUrl: `${ctx.config.publicBaseUrl}/archive`,
      corsOrigins: ctx.config.corsOrigins,
      schedulerEnabled: ctx.config.scheduler.enabled,
      batchSize: ctx.config.send.batchSize,
      warnings: ctx.config.warnings,
      availableProviders: listEmailAdapters(),
    });
  });

  router.post(
    '/uploads',
    asyncRoute(async (req, res) => {
      const fileBase64 = typeof req.body?.fileBase64 === 'string' ? req.body.fileBase64 : '';
      if (!fileBase64.trim()) throw badRequest('請選擇圖片');
      res.status(201).json(
        await saveCampaignImage(
          { driver: ctx.config.store.driver, uploadsPath: ctx.config.uploadsPath },
          fileBase64,
        ),
      );
    }),
  );

  router.get(
    '/overview',
    asyncRoute(async (req, res) => {
      const from = typeof req.query.from === 'string' && req.query.from ? req.query.from : undefined;
      const to = typeof req.query.to === 'string' && req.query.to ? req.query.to : undefined;
      const counts = await ctx.store.countSubscribersByStatus();
      const recent = await listCampaigns(ctx, { limit: 10 });
      const sample = await ctx.store.listSubscribers({ limit: 500 });
      const tags = [...new Set(sample.items.flatMap((s) => s.tags))].sort().slice(0, 50);
      const folders = await listFolders(ctx);
      const rates = await overviewRates(ctx, { from, to });
      res.json({ counts, campaigns: recent.items, provider: ctx.adapter.name, tags, folders, rates });
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
    '/subscribers/tags',
    asyncRoute(async (_req, res) => {
      res.json({ items: await listSubscriberTags(ctx) });
    }),
  );

  router.get(
    '/subscribers',
    asyncRoute(async (req, res) => {
      const result = await listSubscribers(ctx, {
        status: str(req.query.status) as SubscriberStatus | undefined,
        tag: str(req.query.tag),
        folderId: str(req.query.folderId),
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
      let csv = typeof req.body?.csv === 'string' ? req.body.csv : '';
      const fileName = typeof req.body?.fileName === 'string' ? req.body.fileName : '';
      const fileBase64 = typeof req.body?.fileBase64 === 'string' ? req.body.fileBase64 : '';
      if (fileBase64) csv = spreadsheetToCsv(decodeImportFile(fileBase64), fileName || 'import.csv');
      if (csv.trim() === '') throw badRequest('請選擇 CSV 或 Excel 檔案');
      res.json(
        await importSubscribersCsv(
          ctx,
          csv,
          normalizeTags(req.body?.tags),
          typeof req.body?.folderId === 'string' ? req.body.folderId : undefined,
        ),
      );
    }),
  );

  // ── 資料夾 ────────────────────────────────────────────────
  router.get(
    '/folders',
    asyncRoute(async (_req, res) => {
      const [items, counts] = await Promise.all([
        listFolders(ctx),
        ctx.store.countSubscribersByFolder(),
      ]);
      res.json({
        items: items.map((folder) => ({ ...folder, count: counts[folder.id] ?? 0 })),
        unfiled: counts[''] ?? 0,
        total: Object.values(counts).reduce((sum, n) => sum + n, 0),
      });
    }),
  );

  router.post(
    '/folders',
    asyncRoute(async (req, res) => {
      res.status(201).json(await createFolder(ctx, req.body ?? {}));
    }),
  );

  router.patch(
    '/folders/:id',
    asyncRoute(async (req, res) => {
      res.json(await updateFolder(ctx, pathParam(req, 'id'), req.body ?? {}));
    }),
  );

  router.delete(
    '/folders/:id',
    asyncRoute(async (req, res) => {
      await deleteFolder(ctx, pathParam(req, 'id'));
      res.json({ ok: true });
    }),
  );

  router.get(
    '/campaign-folders',
    asyncRoute(async (_req, res) => {
      const [items, counts] = await Promise.all([
        listFolders(ctx, 'campaigns'),
        ctx.store.countCampaignsByFolder(),
      ]);
      res.json({
        items: items.map((folder) => ({ ...folder, count: counts[folder.id] ?? 0 })),
        unfiled: counts[''] ?? 0,
        total: Object.values(counts).reduce((sum, n) => sum + n, 0),
      });
    }),
  );

  router.post(
    '/campaign-folders',
    asyncRoute(async (req, res) => {
      res.status(201).json(await createFolder(ctx, req.body ?? {}, 'campaigns'));
    }),
  );

  router.patch(
    '/campaign-folders/:id',
    asyncRoute(async (req, res) => {
      const folder = await ctx.store.getFolder(pathParam(req, 'id'));
      if (!folder || folder.kind !== 'campaigns') throw badRequest('找不到這個資料夾');
      res.json(await updateFolder(ctx, folder.id, req.body ?? {}));
    }),
  );

  router.delete(
    '/campaign-folders/:id',
    asyncRoute(async (req, res) => {
      const folder = await ctx.store.getFolder(pathParam(req, 'id'));
      if (!folder || folder.kind !== 'campaigns') throw badRequest('找不到這個資料夾');
      await deleteFolder(ctx, folder.id);
      res.json({ ok: true });
    }),
  );

  // ── 電子報 ────────────────────────────────────────────────
  router.get(
    '/campaigns',
    asyncRoute(async (req, res) => {
      res.json(
        await listCampaigns(ctx, {
          status: str(req.query.status) as CampaignStatus | undefined,
          search: str(req.query.search),
          from: str(req.query.from),
          to: str(req.query.to),
          folderId: str(req.query.folderId),
          limit: intParam(req.query.limit, 50),
          offset: intParam(req.query.offset, 0, 1_000_000),
        }),
      );
    }),
  );

  router.post(
    '/campaigns/bulk',
    asyncRoute(async (req, res) => {
      const ids = Array.isArray(req.body?.ids)
        ? req.body.ids.filter((id: unknown): id is string => typeof id === 'string' && id.length > 0)
        : [];
      if (ids.length === 0) throw badRequest('請先選電子報');
      if (ids.length > 100) throw badRequest('一次最多處理 100 封');
      const action = req.body?.action;
      if (action === 'delete') {
        res.json(await bulkDeleteCampaigns(ctx, ids));
        return;
      }
      if (action === 'folder') {
        res.json({ items: await bulkSetCampaignFolder(ctx, ids, req.body?.folderId ?? '') });
        return;
      }
      throw badRequest('不支援這個動作');
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
        bodyHtml: typeof body.bodyHtml === 'string' ? body.bodyHtml : saved.bodyHtml,
        audienceTags:
          body.audienceTags === undefined ? saved.audienceTags : normalizeTags(body.audienceTags),
        audienceFolderId:
          body.audienceFolderId === undefined
            ? saved.audienceFolderId
            : typeof body.audienceFolderId === 'string' && body.audienceFolderId
              ? body.audienceFolderId
              : undefined,
      };
      const rendered = await renderCampaign(ctx, draft, PREVIEW_RECIPIENT);
      const audience = await ctx.store.listAudience(audienceFromCampaign(draft));
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
    '/campaigns/:id/stats',
    asyncRoute(async (req, res) => {
      const campaign = await getCampaign(ctx, pathParam(req, 'id'));
      res.json({ stats: campaign.stats, tracking: campaign.tracking });
    }),
  );

  router.post(
    '/campaigns/:id/template',
    asyncRoute(async (req, res) => {
      res.status(201).json(await createCampaignStarterFromCampaign(ctx, pathParam(req, 'id'), req.body ?? {}));
    }),
  );

  router.get(
    '/sequences',
    asyncRoute(async (_req, res) => {
      res.json({ items: await listSequencesWithSteps(ctx) });
    }),
  );

  router.post(
    '/sequences',
    asyncRoute(async (req, res) => {
      res.status(201).json(await createSequence(ctx, req.body ?? {}));
    }),
  );

  router.get(
    '/sequences/:id',
    asyncRoute(async (req, res) => {
      res.json(await getSequenceWithSteps(ctx, pathParam(req, 'id')));
    }),
  );

  router.patch(
    '/sequences/:id',
    asyncRoute(async (req, res) => {
      res.json(await updateSequence(ctx, pathParam(req, 'id'), req.body ?? {}));
    }),
  );

  router.delete(
    '/sequences/:id',
    asyncRoute(async (req, res) => {
      await deleteSequence(ctx, pathParam(req, 'id'));
      res.json({ ok: true });
    }),
  );

  router.get(
    '/sequences/:id/enrollments',
    asyncRoute(async (req, res) => {
      res.json({ items: await ctx.store.listEnrollments(pathParam(req, 'id')) });
    }),
  );

  router.get(
    '/brand',
    asyncRoute(async (_req, res) => {
      res.json(await getBrand(ctx));
    }),
  );

  router.patch(
    '/brand',
    asyncRoute(async (req, res) => {
      res.json(await updateBrand(ctx, req.body ?? {}));
    }),
  );

  router.get(
    '/campaign-templates',
    asyncRoute(async (_req, res) => {
      res.json({ items: await listCampaignStarters(ctx) });
    }),
  );

  router.post(
    '/campaign-templates',
    asyncRoute(async (req, res) => {
      res.status(201).json(await createCampaignStarter(ctx, req.body ?? {}));
    }),
  );

  router.post(
    '/campaign-templates/:id/copy',
    asyncRoute(async (req, res) => {
      res.status(201).json(await copyCampaignStarter(ctx, pathParam(req, 'id')));
    }),
  );

  router.get(
    '/campaign-templates/:id',
    asyncRoute(async (req, res) => {
      res.json(await getCampaignStarter(ctx, pathParam(req, 'id')));
    }),
  );

  router.patch(
    '/campaign-templates/:id',
    asyncRoute(async (req, res) => {
      res.json(await updateCampaignStarter(ctx, pathParam(req, 'id'), req.body ?? {}));
    }),
  );

  router.delete(
    '/campaign-templates/:id',
    asyncRoute(async (req, res) => {
      await deleteCampaignStarter(ctx, pathParam(req, 'id'));
      res.json({ ok: true });
    }),
  );

  router.get(
    '/templates',
    asyncRoute(async (_req, res) => {
      res.json({ items: await listTemplates(ctx) });
    }),
  );

  router.post(
    '/templates',
    asyncRoute(async (req, res) => {
      res.status(201).json(await createTemplate(ctx, req.body ?? {}));
    }),
  );

  router.patch(
    '/templates/:id',
    asyncRoute(async (req, res) => {
      res.json(await updateTemplate(ctx, pathParam(req, 'id'), req.body ?? {}));
    }),
  );

  router.delete(
    '/templates/:id',
    asyncRoute(async (req, res) => {
      await deleteTemplate(ctx, pathParam(req, 'id'));
      res.json({ ok: true });
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

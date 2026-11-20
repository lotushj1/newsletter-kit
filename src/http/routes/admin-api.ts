import { Router, type Request } from 'express';
import { badRequest } from '../../core/errors.js';
import { saveCampaignImage } from '../../core/uploads.js';
import { decodeImportFile, spreadsheetToCsv } from '../../core/spreadsheet.js';
import { normalizeEmail, normalizeTags } from '../../core/validate.js';
import { listEmailAdapters } from '../../email/registry.js';
import {
  applyAutomation,
  draftAutomation,
  draftCampaign,
  interpretFilter,
  organizeCampaigns,
  organizeSubscribers,
  rewriteSelection,
  suggestSubjects,
} from '../../ai/tasks.js';
import { publicSession } from '../../services/session.js';
import { approveHeldUnsubscribes, getNotionInboundStatus } from '../../services/notion-inbound-sync.js';
import {
  bulkDeleteCampaigns,
  bulkSetCampaignFolder,
  copyCampaign,
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
  copySequence,
  createSequence,
  deleteSequence,
  getSequenceWithSteps,
  listSequencesWithSteps,
  updateSequence,
} from '../../services/sequences.js';
import {
  cancelSending,
  listReconcileQueue,
  reconcileUnconfirmed,
  resumeCampaign,
  sendTestEmail,
  startCampaign,
} from '../../services/sending.js';
import { campaignReceiptStats, deliveryState } from '../../services/delivery-receipts.js';
import {
  createFolder,
  deleteFolder,
  listFolders,
  updateFolder,
} from '../../services/folders.js';
import { getBrand, updateBrand } from '../../services/brand.js';
import { campaignLinkStats } from '../../services/link-stats.js';
import { parseAudienceCondition, selectAudience } from '../../services/audience.js';
import {
  integrationView,
  updateAiIntegration,
  updateEmailIntegration,
} from '../../services/integrations.js';
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
  exportSubscriberData,
  exportSubscribersCsv,
  importSubscribersCsv,
  listSubscribers,
  listSubscriberTags,
  updateSubscriber,
} from '../../services/subscribers.js';
import {
  audienceFromCampaign,
  type Campaign,
  type CampaignStatus,
  type DeliveryStatus,
  type SubscriberStatus,
} from '../../store/types.js';
import {
  aiIntegrationSummary,
  brandSummary,
  emailIntegrationSummary,
  importSummary,
  listAuditLog,
  reconcileSummary,
  recordAudit,
  sendAction,
  sendSummary,
  subscriberUpdateSummary,
  type AuditAction,
  type AuditDetails,
} from '../../services/audit.js';
import { adminActor, requireAdmin } from '../auth.js';
import { asyncRoute, intParam, pathParam } from '../helpers.js';

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

const DELIVERY_STATUSES: readonly DeliveryStatus[] = ['pending', 'sending', 'sent', 'failed', 'skipped'];

export function adminApiRouter(ctx: ServiceContext): Router {
  const router = Router();
  router.use(requireAdmin(ctx.config));
  /** 動作完成後記一筆操作紀錄（actor：Google 登入的 email，或 admin-token）。 */
  const audit = (req: Request, action: AuditAction, details?: AuditDetails) =>
    recordAudit(ctx, adminActor(ctx.config, req), action, details);

  router.get('/session', (_req, res) => {
    res.json(publicSession(ctx));
  });

  router.get('/integrations', (_req, res) => {
    res.json(integrationView(ctx));
  });

  router.patch(
    '/integrations/email',
    asyncRoute(async (req, res) => {
      const view = await updateEmailIntegration(ctx, req.body ?? {});
      await audit(req, 'settings.email', { summary: emailIntegrationSummary(req.body, view.email.provider) });
      res.json(view);
    }),
  );

  router.patch(
    '/integrations/ai',
    asyncRoute(async (req, res) => {
      const view = await updateAiIntegration(ctx, req.body ?? {});
      await audit(req, 'settings.ai', { summary: aiIntegrationSummary(req.body, view.ai) });
      res.json(view);
    }),
  );

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
      const notionSync = await getNotionInboundStatus(ctx);
      res.json({ counts, campaigns: recent.items, provider: ctx.adapter.name, tags, folders, rates, notionSync });
    }),
  );

  router.get(
    '/notion-sync',
    asyncRoute(async (_req, res) => {
      res.json(await getNotionInboundStatus(ctx));
    }),
  );

  // Notion 一次退訂太多人而暫停時，由後台確認後套用。
  router.post(
    '/notion-sync/approve-unsubscribes',
    asyncRoute(async (req, res) => {
      const summary = await approveHeldUnsubscribes(ctx);
      if (summary.reason === 'nothing_held') throw badRequest('目前沒有暫停中的退訂');
      if (!summary.ran) throw badRequest('Notion 名單同步沒有啟用，無法套用');
      await audit(req, 'subscribers.approve_unsubscribes', { summary: `套用退訂 ${summary.unsubscribed} 筆` });
      res.json({ summary, status: await getNotionInboundStatus(ctx) });
    }),
  );

  router.get(
    '/email/verify',
    asyncRoute(async (_req, res) => {
      const result = await ctx.adapter.verify();
      res.json({ ...result, provider: ctx.adapter.name, available: listEmailAdapters() });
    }),
  );

  router.get(
    '/ai/verify',
    asyncRoute(async (_req, res) => {
      if (!ctx.ai) {
        res.json({ ok: false, message: '尚未接上 AI', provider: ctx.config.ai.provider, model: null });
        return;
      }
      const result = await ctx.ai.verify();
      res.json({ ...result, provider: ctx.ai.name, model: ctx.ai.model });
    }),
  );

  router.post(
    '/ai/draft',
    asyncRoute(async (req, res) => {
      res.json(await draftCampaign(ctx, req.body ?? {}));
    }),
  );

  router.post(
    '/ai/rewrite',
    asyncRoute(async (req, res) => {
      res.json(await rewriteSelection(ctx, req.body ?? {}));
    }),
  );

  router.post(
    '/ai/subjects',
    asyncRoute(async (req, res) => {
      res.json(await suggestSubjects(ctx, req.body ?? {}));
    }),
  );

  router.post(
    '/ai/organize-subscribers',
    asyncRoute(async (req, res) => {
      res.json(await organizeSubscribers(ctx, req.body ?? {}));
    }),
  );

  router.post(
    '/ai/organize-campaigns',
    asyncRoute(async (req, res) => {
      res.json(await organizeCampaigns(ctx, req.body ?? {}));
    }),
  );

  router.post(
    '/ai/filter',
    asyncRoute(async (req, res) => {
      res.json(await interpretFilter(ctx, req.body ?? {}));
    }),
  );

  router.post(
    '/ai/automation',
    asyncRoute(async (req, res) => {
      res.json(await draftAutomation(ctx, req.body ?? {}));
    }),
  );

  router.post(
    '/ai/automation/apply',
    asyncRoute(async (req, res) => {
      res.status(201).json(await applyAutomation(ctx, req.body ?? {}));
    }),
  );

  // ── 訂閱者 ────────────────────────────────────────────────
  router.get(
    '/subscribers/export.csv',
    asyncRoute(async (req, res) => {
      const csv = await exportSubscribersCsv(ctx);
      await audit(req, 'subscribers.export', { summary: '匯出全部訂閱者（CSV）' });
      res.setHeader('content-type', 'text/csv; charset=utf-8');
      res.setHeader('content-disposition', 'attachment; filename="subscribers.csv"');
      res.send(csv);
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

  router.get(
    '/subscribers/:id/export.json',
    asyncRoute(async (req, res) => {
      const id = pathParam(req, 'id');
      const data = await exportSubscriberData(ctx, id);
      await audit(req, 'subscriber.export', { targetId: id, summary: '匯出單一訂閱者的個人資料（JSON）' });
      res.setHeader('content-disposition', `attachment; filename="subscriber-${id}.json"`);
      res.setHeader('cache-control', 'no-store');
      res.json(data);
    }),
  );

  router.patch(
    '/subscribers/:id',
    asyncRoute(async (req, res) => {
      const updated = await updateSubscriber(ctx, pathParam(req, 'id'), req.body ?? {});
      await audit(req, 'subscriber.update', {
        targetId: updated.id,
        summary: subscriberUpdateSummary(req.body, updated.status),
      });
      res.json(updated);
    }),
  );

  router.delete(
    '/subscribers/:id',
    asyncRoute(async (req, res) => {
      const id = pathParam(req, 'id');
      await deleteSubscriber(ctx, id);
      await audit(req, 'subscriber.delete', { targetId: id, summary: '刪除訂閱者' });
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
      const dryRun = req.body?.dryRun === true;
      const result = await importSubscribersCsv(
        ctx,
        csv,
        normalizeTags(req.body?.tags),
        typeof req.body?.folderId === 'string' ? req.body.folderId : undefined,
        { dryRun },
      );
      // 預覽沒有改動名單，不記操作紀錄；確認匯入才記。
      if (!dryRun) await audit(req, 'subscribers.import', { summary: importSummary(result) });
      res.json(result);
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
        const result = await bulkDeleteCampaigns(ctx, ids);
        const failed = new Set(result.failed.map((item) => item.id));
        for (const id of ids.filter((item: string) => !failed.has(item))) {
          await audit(req, 'campaign.delete', { targetId: id, summary: '批次刪除（連同寄送紀錄與追蹤事件）' });
        }
        res.json(result);
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
      const id = pathParam(req, 'id');
      await deleteCampaign(ctx, id);
      await audit(req, 'campaign.delete', { targetId: id, summary: '刪除（連同寄送紀錄與追蹤事件）' });
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
        audienceCondition: body.audienceCondition === undefined ? saved.audienceCondition : parseAudienceCondition(body.audienceCondition),
        audienceFolderId:
          body.audienceFolderId === undefined
            ? saved.audienceFolderId
            : typeof body.audienceFolderId === 'string' && body.audienceFolderId
              ? body.audienceFolderId
              : undefined,
      };
      const rendered = await renderCampaign(ctx, draft, PREVIEW_RECIPIENT);
      const audience = await selectAudience(ctx, draft);
      res.json({ ...rendered, audienceCount: audience.length });
    }),
  );
  router.post('/campaigns/:id/audience-count', asyncRoute(async (req, res) => {
    const campaign = await getCampaign(ctx, pathParam(req, 'id'));
    const body = req.body ?? {};
    const draft = { ...campaign,
      audienceTags: body.audienceTags === undefined ? campaign.audienceTags : normalizeTags(body.audienceTags),
      audienceFolderId: body.audienceFolderId === undefined ? campaign.audienceFolderId : String(body.audienceFolderId || '') || undefined,
      audienceCondition: body.audienceCondition === undefined ? campaign.audienceCondition : parseAudienceCondition(body.audienceCondition),
    };
    res.json({ count: (await selectAudience(ctx, draft)).length });
  }));

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
      const campaign = await scheduleCampaign(ctx, pathParam(req, 'id'), req.body?.scheduledAt);
      await audit(req, 'campaign.schedule', { targetId: campaign.id, summary: `排程時間 ${campaign.scheduledAt ?? ''}` });
      res.json(campaign);
    }),
  );

  router.post(
    '/campaigns/:id/unschedule',
    asyncRoute(async (req, res) => {
      const campaign = await cancelSchedule(ctx, pathParam(req, 'id'));
      await audit(req, 'campaign.unschedule', { targetId: campaign.id, summary: '改回草稿' });
      res.json(campaign);
    }),
  );

  router.post(
    '/campaigns/:id/send',
    asyncRoute(async (req, res) => {
      const id = pathParam(req, 'id');
      const action = await sendAction(ctx, id);
      const result = await startCampaign(ctx, id, { background: true });
      await audit(req, action, { targetId: id, summary: sendSummary(result.total) });
      res.json({ ok: true, total: result.total });
    }),
  );

  // 人工續寄：只寄仍是 pending 的；停在 sending（結果不明）的不會重寄。
  router.post(
    '/campaigns/:id/resume',
    asyncRoute(async (req, res) => {
      const id = pathParam(req, 'id');
      const result = await resumeCampaign(ctx, id, { background: true });
      await audit(req, 'campaign.resume', { targetId: id, summary: '續寄仍在佇列中的收件人' });
      res.json({ ok: true, ...result });
    }),
  );

  // 對帳：把結果不明的寄送紀錄拿去供應商查，查到才標成已寄出；每筆都記下誰、何時、結果與原因。
  router.post(
    '/campaigns/:id/reconcile',
    asyncRoute(async (req, res) => {
      const id = pathParam(req, 'id');
      const result = await reconcileUnconfirmed(ctx, id, adminActor(ctx.config, req));
      await audit(req, 'campaign.reconcile', { targetId: id, summary: reconcileSummary(result) });
      res.json(result);
    }),
  );

  // 跨電子報的待對帳清單（結果不明的寄送紀錄，最早的排前面）。
  router.get(
    '/deliveries/unconfirmed',
    asyncRoute(async (req, res) => {
      res.json(await listReconcileQueue(ctx, { limit: intParam(req.query.limit, 500, 5000) }));
    }),
  );

  router.post(
    '/campaigns/:id/cancel',
    asyncRoute(async (req, res) => {
      const campaign = await cancelSending(ctx, pathParam(req, 'id'));
      await audit(req, 'campaign.cancel', { targetId: campaign.id, summary: '未寄出的收件人改為略過' });
      res.json(campaign);
    }),
  );

  router.get(
    '/campaigns/:id/stats',
    asyncRoute(async (req, res) => {
      const campaign = await getCampaign(ctx, pathParam(req, 'id'));
      res.json({ stats: campaign.stats, tracking: campaign.tracking });
    }),
  );
  router.get('/campaigns/:id/links', asyncRoute(async (req, res) => {
    const id = pathParam(req, 'id');
    await getCampaign(ctx, id);
    res.json({ items: await campaignLinkStats(ctx, id) });
  }));

  router.post(
    '/campaigns/:id/copy',
    asyncRoute(async (req, res) => {
      res.status(201).json(await copyCampaign(ctx, pathParam(req, 'id')));
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

  router.post(
    '/sequences/:id/copy',
    asyncRoute(async (req, res) => {
      res.status(201).json(await copySequence(ctx, pathParam(req, 'id')));
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
      const brand = await updateBrand(ctx, req.body ?? {});
      await audit(req, 'settings.brand', { summary: brandSummary(req.body) });
      res.json(brand);
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

  // 操作紀錄（唯讀）：新到舊，預設 100 筆、最多 500 筆。
  router.get(
    '/audit-log',
    asyncRoute(async (req, res) => {
      res.json({ items: await listAuditLog(ctx, intParam(req.query.limit, 100, 500)) });
    }),
  );

  router.get(
    '/campaigns/:id/deliveries',
    asyncRoute(async (req, res) => {
      const status = str(req.query.status);
      if (status && !DELIVERY_STATUSES.includes(status as DeliveryStatus)) {
        throw badRequest(`status 只能是 ${DELIVERY_STATUSES.join(' / ')}`);
      }
      const deliveries = await ctx.store.listDeliveries(pathParam(req, 'id'), {
        status: status as DeliveryStatus | undefined,
        limit: intParam(req.query.limit, 200, 2000),
      });
      res.json({
        items: deliveries.map((delivery) => ({ ...delivery, state: deliveryState(delivery) })),
        stats: await ctx.store.deliveryStats(pathParam(req, 'id')),
      });
    }),
  );

  // 服務商回報統計：已收下／已送達／退信／檢舉／結果不明…（開信點擊不算送達）。
  router.get(
    '/campaigns/:id/receipts',
    asyncRoute(async (req, res) => {
      res.json(await campaignReceiptStats(ctx, pathParam(req, 'id')));
    }),
  );

  return router;
}

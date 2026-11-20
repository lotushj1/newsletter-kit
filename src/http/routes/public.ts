import { Router } from 'express';
import { unauthorized } from '../../core/errors.js';
import { verifyToken } from '../../core/tokens.js';
import { SIG_ICON_FILE, sigIconBuffer } from '../../core/sig-icons.js';
import { resolvePublicUpload } from '../../core/uploads.js';
import { normalizeTags } from '../../core/validate.js';
import { publicSubject, renderPublicCampaign } from '../../services/campaigns.js';
import { emailBrandName } from '../../core/brand-signature.js';
import { getBrand } from '../../services/brand.js';
import { currentDisclosure } from '../../services/consent.js';
import type { ServiceContext } from '../../services/context.js';
import {
  ingestEvent,
  ingestSubscriber,
  requireIngestSecret,
  verifyIngestSignature,
} from '../../services/ingest.js';
import {
  confirmSubscription,
  subscribe,
  unsubscribeByToken,
} from '../../services/subscribers.js';
import type { RequestWithRawBody } from '../app.js';
import {
  archiveIndexPage,
  archiveItemPage,
  archiveNotFoundPage,
  confirmResultPage,
  joinPage,
  homePage,
  unsubscribeConfirmPage,
  unsubscribeResultPage,
} from '../views/pages.js';
import { asyncRoute, intParam, pathParam, rateLimit } from '../helpers.js';

function assertIngest(ctx: ServiceContext, req: RequestWithRawBody): void {
  const secret = requireIngestSecret(ctx);
  const header = typeof req.headers['x-newsletter-signature'] === 'string'
    ? req.headers['x-newsletter-signature']
    : undefined;
  if (!verifyIngestSignature(secret, req.rawBody ?? JSON.stringify(req.body ?? {}), header)) {
    throw unauthorized('匯入簽章不正確');
  }
}

export function publicRouter(ctx: ServiceContext): Router {
  const router = Router();
  const limiter = rateLimit(ctx.config.publicRateLimitPerMin);

  router.get('/health', (_req, res) => {
    const integrity = (ctx.store as { integrityStatus?: () => { ok: boolean; reason?: string } })
      .integrityStatus?.() ?? { ok: true };
    res.status(integrity.ok ? 200 : 503).json({
      ok: integrity.ok,
      provider: ctx.adapter.name,
      store: ctx.store.driver,
      storeIntegrity: integrity.ok ? 'ok' : 'frozen',
      scheduler: ctx.config.scheduler.enabled ? 'enabled' : 'disabled',
      sendAutoResume: !!ctx.config.send.autoResume,
      sendPaused: !!ctx.config.send.paused,
    });
  });

  router.get('/sig-icons/:file', (req, res) => {
    const file = pathParam(req, 'file');
    const match = SIG_ICON_FILE.exec(file);
    const png = match ? sigIconBuffer(match[1] ?? '') : null;
    if (!png) {
      res.status(404).type('text').send('找不到圖示');
      return;
    }
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.type('image/png').send(png);
  });

  router.get('/media/:file', (req, res) => {
    const file = resolvePublicUpload(ctx.config.uploadsPath, pathParam(req, 'file'));
    if (!file) {
      res.status(404).type('text').send('找不到圖片');
      return;
    }
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.type(file.mime).sendFile(file.absolute);
  });

  router.get(
    '/',
    asyncRoute(async (_req, res) => {
      const [{ lines, privacyUrl }, brand, recent] = await Promise.all([
        currentDisclosure(ctx),
        getBrand(ctx),
        ctx.store.listCampaigns({ status: 'sent', limit: 5 }),
      ]);
      res.type('html').send(
        homePage(ctx.config.siteName, {
          publisher: emailBrandName(brand, ctx.config.siteName) || ctx.config.siteName,
          description: ctx.config.join.description,
          frequency: ctx.config.join.frequency,
          disclosure: lines,
          privacyUrl,
          recent: recent.items,
        }),
      );
    }),
  );

  router.get(
    '/join',
    asyncRoute(async (req, res) => {
      const queryTags = normalizeTags(req.query.tags);
      const { lines, privacyUrl } = await currentDisclosure(ctx);
      res.type('html').send(
        joinPage(ctx.config.siteName, {
          headline: ctx.config.join.headline,
          description: ctx.config.join.description,
          tags: queryTags.length > 0 ? queryTags : ctx.config.join.tags,
          disclosure: lines,
          privacyUrl,
        }),
      );
    }),
  );

  router.post(
    '/join',
    limiter,
    asyncRoute(async (req, res) => {
      const tags = normalizeTags(req.body?.tags ?? ctx.config.join.tags);
      const { lines, privacyUrl } = await currentDisclosure(ctx);
      try {
        const outcome = await subscribe(ctx, {
          email: req.body?.email,
          name: req.body?.name,
          tags,
          source: 'join_page',
        });
        res.type('html').send(
          joinPage(ctx.config.siteName, {
            headline: ctx.config.join.headline,
            description: ctx.config.join.description,
            tags,
            ok: true,
            message: outcome.message,
            disclosure: lines,
            privacyUrl,
          }),
        );
      } catch (error) {
        res.status(400).type('html').send(
          joinPage(ctx.config.siteName, {
            headline: ctx.config.join.headline,
            description: ctx.config.join.description,
            tags,
            ok: false,
            message: error instanceof Error ? error.message : '訂閱失敗',
            disclosure: lines,
            privacyUrl,
            email: typeof req.body?.email === 'string' ? req.body.email.slice(0, 254) : undefined,
            name: typeof req.body?.name === 'string' ? req.body.name.slice(0, 120) : undefined,
          }),
        );
      }
    }),
  );

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

  router.post(
    '/api/public/ingest',
    limiter,
    asyncRoute(async (req, res) => {
      assertIngest(ctx, req);
      const result = await ingestSubscriber(ctx, req.body ?? {});
      res.status(result.action === 'created' ? 201 : 200).json({
        ok: true,
        action: result.action,
        email: result.subscriber.email,
      });
    }),
  );

  router.post(
    '/api/public/events',
    limiter,
    asyncRoute(async (req, res) => {
      assertIngest(ctx, req);
      res.json(await ingestEvent(ctx, req.body ?? {}));
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
        items: await Promise.all(
          result.items.map(async (c) => ({
            slug: c.slug,
            title: c.title,
            subject: await publicSubject(ctx, c),
            preheader: c.preheader ?? null,
            sentAt: c.sentAt ?? null,
          })),
        ),
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

  /** 公開封存頁：只顯示已寄出的電子報。 */
  router.get(
    '/archive',
    asyncRoute(async (_req, res) => {
      const result = await ctx.store.listCampaigns({ status: 'sent', limit: 100 });
      res.type('html').send(archiveIndexPage(ctx.config.siteName, result.items));
    }),
  );

  router.get(
    '/archive/:slug',
    asyncRoute(async (req, res) => {
      const found = await renderPublicCampaign(ctx, pathParam(req, 'slug'));
      if (!found) {
        res.status(404).type('html').send(archiveNotFoundPage(ctx.config.siteName));
        return;
      }
      res
        .type('html')
        .send(archiveItemPage(ctx.config.siteName, found.campaign, found.subject, found.html));
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
      const oneClick = req.body?.['List-Unsubscribe'] === 'One-Click';
      const result = await unsubscribeByToken(ctx, String(req.body?.token ?? req.query.token ?? ''));
      if (oneClick) {
        res.status(result.ok ? 200 : 400).type('text').send(result.message);
        return;
      }
      res
        .status(result.ok ? 200 : 400)
        .type('html')
        .send(unsubscribeResultPage(ctx.config.siteName, result.message));
    }),
  );

  return router;
}

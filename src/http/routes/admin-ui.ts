import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { Router } from 'express';
import type { ServiceContext } from '../../services/context.js';
import {
  clearAdminCookie,
  isAuthorized,
  requireAdminPage,
  setAdminCookie,
} from '../auth.js';
import { loginPage } from '../views/pages.js';

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

function resolveAdminDist(): string {
  const candidates = [
    join(dirname(fileURLToPath(import.meta.url)), '../../../admin/dist'),
    join(process.cwd(), 'admin/dist'),
    join(process.cwd(), 'public/admin'),
  ];
  return candidates.find((dir) => existsSync(join(dir, 'index.html'))) ?? candidates[0]!;
}

function spaIndex(): string | null {
  const index = join(resolveAdminDist(), 'index.html');
  return existsSync(index) ? readFileSync(index, 'utf8') : null;
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
  router.use(express.static(resolveAdminDist(), { index: false, fallthrough: true }));

  router.get(/.*/, (req, res) => {
    if (/\.[a-z0-9]+$/i.test(req.path)) {
      res.status(404).type('text').send('找不到這個檔案');
      return;
    }
    const html = spaIndex();
    if (html) {
      res.type('html').send(html);
      return;
    }
    res
      .status(503)
      .type('html')
      .send(
        '<h1>後台尚未建置</h1><p>請在專案根目錄執行 <code>npm run build</code> 或 <code>npm run dev</code>。</p>',
      );
  });

  return router;
}

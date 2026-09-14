import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { AppError } from '../core/errors.js';
import { logger } from '../core/logger.js';
import type { ServiceContext } from '../services/context.js';
import { adminApiRouter } from './routes/admin-api.js';
import { adminUiRouter } from './routes/admin-ui.js';
import { publicRouter } from './routes/public.js';
import { trackingRouter } from './routes/tracking.js';

export type RequestWithRawBody = Request & { rawBody?: string };

/** 只有公開端點需要跨網域，後台維持同源。 */
function cors(allowed: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    if (origin && (allowed.includes('*') || allowed.includes(origin))) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'content-type, x-newsletter-signature');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    }
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  };
}

export function createApp(ctx: ServiceContext): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.use(
    express.json({
      limit: '8mb',
      verify: (req, _res, buf) => {
        (req as RequestWithRawBody).rawBody = buf.toString('utf8');
      },
    }),
  );
  app.use(express.urlencoded({ extended: false, limit: '2mb' }));

  app.use(/^\/(health|api\/public|t\/)/, cors(ctx.config.corsOrigins));
  app.use('/', publicRouter(ctx));
  app.use('/', trackingRouter(ctx));
  app.use('/api/admin', adminApiRouter(ctx));
  app.use('/admin', adminUiRouter(ctx));

  app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
      res.status(404).json({ error: '找不到這個端點' });
      return;
    }
    res.status(404).type('html').send('<h1>404</h1><p>找不到頁面。</p>');
  });

  app.use((error: Error, req: Request, res: Response, _next: NextFunction) => {
    const status = error instanceof AppError ? error.status : 500;
    if (status >= 500) logger.error('未預期的錯誤', { path: req.path, error: error.message });
    const message = status >= 500 ? '伺服器發生錯誤' : error.message;
    if (req.path.startsWith('/api/') || req.headers.accept?.includes('application/json')) {
      res.status(status).json({ error: message });
      return;
    }
    res.status(status).type('html').send(`<h1>${status}</h1><p>${message}</p>`);
  });

  return app;
}

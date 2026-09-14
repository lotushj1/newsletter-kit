import { logger } from './core/logger.js';
import { createApp } from './http/app.js';
import { createRuntime } from './runtime.js';
import { createScheduler } from './services/scheduler.js';

async function main(): Promise<void> {
  const ctx = await createRuntime();
  const scheduler = createScheduler(ctx);
  if (ctx.config.scheduler.enabled) scheduler.start();
  else logger.warn('SCHEDULER_ENABLED=false，排程的電子報不會自動寄出。');

  const server = createApp(ctx).listen(ctx.config.port, '0.0.0.0', () => {
    logger.info(`啟動完成：${ctx.config.publicBaseUrl}`, {
      store: ctx.store.driver,
      provider: ctx.adapter.name,
    });
    logger.info(`後台：${ctx.config.publicBaseUrl}/admin`);
  });

  const shutdown = (signal: string) => {
    logger.info(`收到 ${signal}，準備關閉`);
    scheduler.stop();
    server.close(() => {
      void ctx.store.close().then(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  logger.error('啟動失敗', { error: (error as Error).message });
  process.exitCode = 1;
});

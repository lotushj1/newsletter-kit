import { loadConfig, loadEnvFile } from './config.js';
import { logger } from './core/logger.js';
import { createEmailAdapter } from './email/registry.js';
import { createApp } from './http/app.js';
import type { ServiceContext } from './services/context.js';
import { createScheduler } from './services/scheduler.js';
import { createStore } from './store/index.js';

async function main(): Promise<void> {
  loadEnvFile();
  const config = loadConfig();
  for (const warning of config.warnings) logger.warn(warning);

  const store = createStore(config.store.driver, config.store.path);
  await store.init();

  const adapter = createEmailAdapter({
    provider: config.email.provider,
    webhookUrl: config.email.webhookUrl,
    webhookSecret: config.email.webhookSecret,
    resendApiKey: config.email.resendApiKey,
    zeaburEndpoint: config.email.zeaburEndpoint,
    zeaburToken: config.email.zeaburToken,
  });
  const verification = await adapter.verify();
  logger[verification.ok ? 'info' : 'warn'](`寄信管道 ${adapter.name}：${verification.message}`);

  const ctx: ServiceContext = { config, store, adapter };
  const scheduler = createScheduler(ctx);
  if (config.scheduler.enabled) scheduler.start();
  else logger.warn('SCHEDULER_ENABLED=false，排程的電子報不會自動寄出。');

  const server = createApp(ctx).listen(config.port, () => {
    logger.info(`啟動完成：${config.publicBaseUrl}`, {
      store: store.driver,
      provider: adapter.name,
    });
    logger.info(`後台：${config.publicBaseUrl}/admin`);
  });

  const shutdown = (signal: string) => {
    logger.info(`收到 ${signal}，準備關閉`);
    scheduler.stop();
    server.close(() => {
      void store.close().then(() => process.exit(0));
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

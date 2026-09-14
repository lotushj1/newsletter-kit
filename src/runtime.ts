import { loadConfig, loadEnvFile } from './config.js';
import { logger } from './core/logger.js';
import { createEmailAdapter } from './email/registry.js';
import type { ServiceContext } from './services/context.js';
import { createStore } from './store/index.js';

export async function createRuntime(): Promise<ServiceContext> {
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
    insforgeUrl: config.email.insforgeUrl,
    insforgeApiKey: config.email.insforgeApiKey,
  });
  const verification = await adapter.verify();
  logger[verification.ok ? 'info' : 'warn'](`寄信管道 ${adapter.name}：${verification.message}`);

  return { config, store, adapter };
}

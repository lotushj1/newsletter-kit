import { loadConfig, loadEnvFile } from './config.js';
import { logger } from './core/logger.js';
import { createAiAdapter } from './ai/registry.js';
import { createEmailAdapter } from './email/registry.js';
import type { ServiceContext } from './services/context.js';
import { applyStoredIntegrations, emailAdapterContext } from './services/integrations.js';
import { createStore } from './store/index.js';

export async function createRuntime(): Promise<ServiceContext> {
  loadEnvFile();
  const config = loadConfig();
  for (const warning of config.warnings) logger.warn(warning);

  const store = createStore(config.store.driver, config.store.path);
  await store.init();
  await applyStoredIntegrations(config, store);

  const adapter = createEmailAdapter(emailAdapterContext(config));
  const verification = await adapter.verify();
  logger[verification.ok ? 'info' : 'warn'](`寄信管道 ${adapter.name}：${verification.message}`);

  const ai = createAiAdapter(config.ai);
  if (ai) {
    const aiCheck = await ai.verify();
    logger[aiCheck.ok ? 'info' : 'warn'](`AI ${ai.name}：${aiCheck.message}`);
  }

  return { config, store, adapter, ai };
}

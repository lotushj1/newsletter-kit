import { aiServiceLabel, getAiService } from '../ai/providers.js';
import { providerLimitationWarnings } from '../email/providers.js';
import { listEmailAdapters } from '../email/registry.js';
import type { ServiceContext } from './context.js';

export function publicBase(ctx: ServiceContext): string {
  return ctx.config.publicBaseUrl.replace(/\/$/, '');
}

/** 給後台與 Agent 的設定摘要。不含 token。 */
export function publicSession(ctx: ServiceContext) {
  const base = publicBase(ctx);
  return {
    siteName: ctx.config.siteName,
    provider: ctx.adapter.name,
    storeDriver: ctx.store.driver,
    publicBaseUrl: ctx.config.publicBaseUrl,
    from: ctx.config.email.from,
    replyTo: ctx.config.email.replyTo ?? null,
    doubleOptIn: ctx.config.doubleOptIn,
    trackingEnabled: ctx.config.trackingEnabled,
    joinUrl: `${base}/join`,
    archiveUrl: `${base}/archive`,
    mcpUrl: `${base}/mcp`,
    adminApiUrl: `${base}/api/admin`,
    corsOrigins: ctx.config.corsOrigins,
    schedulerEnabled: ctx.config.scheduler.enabled,
    batchSize: ctx.config.send.batchSize,
    // 寄信管道可在後台切換，所以它的限制每次即時算，不放進啟動時的 config.warnings。
    warnings: [...ctx.config.warnings, ...providerLimitationWarnings(ctx.config.email.provider)],
    availableProviders: listEmailAdapters(),
    ai: {
      configured: Boolean(ctx.ai),
      provider: ctx.config.ai.provider,
      label: aiServiceLabel(ctx.config.ai.provider),
      model: ctx.config.ai.model ?? null,
      writes: Boolean(ctx.ai) && getAiService(ctx.config.ai.provider)?.protocol !== 'systemone',
    },
  };
}

import { aiServiceLabel, getAiService } from '../ai/providers.js';
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
    warnings: ctx.config.warnings,
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

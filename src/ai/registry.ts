import { createAnthropicAdapter } from './adapters/anthropic.js';
import { createJevAdapter } from './adapters/jev.js';
import { createOpenAiCompatibleAdapter } from './adapters/openai-compatible.js';
import { AI_SERVICES, getAiService } from './providers.js';
import type { AiAdapter, AiConfig } from './types.js';

/** 設定不齊就回 null。呼叫端應顯示「尚未接上 AI」，不要用假結果充數。 */
export function createAiAdapter(config: AiConfig): AiAdapter | null {
  if (!config.provider || config.provider === 'none') return null;
  const service = getAiService(config.provider);
  const legacy = config.provider === 'compatible';
  if (!service && !legacy) return null;
  if (service?.protocol === 'none') return null;
  const model = config.model || service?.defaultModel;
  if (!model) return null;
  if (!config.apiKey && !service?.optionalKey) return null;
  const resolved: AiConfig = {
    ...config,
    model,
    baseUrl: config.baseUrl || service?.baseUrl,
  };
  if (service?.protocol === 'anthropic') return createAnthropicAdapter(resolved);
  if (service?.protocol === 'systemone') return createJevAdapter(resolved);
  if (!resolved.baseUrl) return null;
  return createOpenAiCompatibleAdapter(resolved);
}

export function listAiProviders(): string[] {
  return [...AI_SERVICES.map((service) => service.id), 'compatible'];
}

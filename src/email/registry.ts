import { createDryRunAdapter } from './adapters/dry-run.js';
import { createResendAdapter } from './adapters/resend.js';
import { createWebhookAdapter } from './adapters/webhook.js';
import { createInsForgeAdapter } from './adapters/insforge.js';
import { createZeaburAdapter } from './adapters/zeabur.js';
import type { AdapterContext, EmailAdapter, EmailAdapterFactory, EmailMessage, SendResult } from './types.js';

const registry = new Map<string, EmailAdapterFactory>([
  ['dry_run', createDryRunAdapter],
  ['webhook', createWebhookAdapter],
  ['resend', createResendAdapter],
  ['zeabur', createZeaburAdapter],
  ['insforge', createInsForgeAdapter],
]);

/** 接自家供應商：registerEmailAdapter('my-provider', (ctx) => ({ ... })) */
export function registerEmailAdapter(name: string, factory: EmailAdapterFactory): void {
  registry.set(name, factory);
}

export function listEmailAdapters(): string[] {
  return [...registry.keys()];
}

export function createEmailAdapter(context: AdapterContext): EmailAdapter {
  const factory = registry.get(context.provider);
  if (!factory) {
    throw new Error(
      `找不到 EMAIL_PROVIDER=${context.provider}。可用：${listEmailAdapters().join(', ')}`,
    );
  }
  return factory(context);
}

/** adapter 沒實作 sendBatch 時的預設行為：逐封送，不平行以免踩供應商速率限制。 */
export async function sendMessages(
  adapter: EmailAdapter,
  messages: EmailMessage[],
): Promise<SendResult[]> {
  if (adapter.sendBatch) return adapter.sendBatch(messages);
  const results: SendResult[] = [];
  for (const message of messages) {
    try {
      results.push(await adapter.send(message));
    } catch (error) {
      results.push({ ok: false, error: (error as Error).message, retryable: true });
    }
  }
  return results;
}

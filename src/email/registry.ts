import { createDryRunAdapter } from './adapters/dry-run.js';
import { createHttpPlatformAdapter } from './adapters/http-platform.js';
import { createResendAdapter } from './adapters/resend.js';
import { createSesAdapter } from './adapters/ses.js';
import { createWebhookAdapter } from './adapters/webhook.js';
import { createInsForgeAdapter } from './adapters/insforge.js';
import { createPortalyAdapter } from './adapters/portaly.js';
import { createZeaburAdapter } from './adapters/zeabur.js';
import { EMAIL_PLATFORMS } from './providers.js';
import type { AdapterContext, EmailAdapter, EmailAdapterFactory, EmailMessage, SendResult } from './types.js';
import { withEmailHeaders } from './headers.js';

const registry = new Map<string, EmailAdapterFactory>([
  ['dry_run', createDryRunAdapter],
  ['webhook', createWebhookAdapter],
  ['resend', createResendAdapter],
  ['portaly', createPortalyAdapter],
  ['zeabur', createZeaburAdapter],
  ['insforge', createInsForgeAdapter],
  ['ses', createSesAdapter],
]);

for (const platform of EMAIL_PLATFORMS) {
  if (platform.kind === 'http' && !registry.has(platform.id)) {
    registry.set(platform.id, createHttpPlatformAdapter(platform.id));
  }
}

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

/**
 * adapter 沒實作 sendBatch 時的預設行為：逐封送，不平行以免踩供應商速率限制。
 * adapter.send 丟錯（而不是回傳失敗結果）時不知道服務商收了沒有，當成結果不明：
 * 寄送紀錄停在 sending 等對帳，不自動重寄。內建 adapter 都會把連線錯誤轉成回傳值。
 */
export async function sendMessages(
  adapter: EmailAdapter,
  messages: EmailMessage[],
): Promise<SendResult[]> {
  if (adapter.sendBatch) return adapter.sendBatch(messages.map(withEmailHeaders));
  const results: SendResult[] = [];
  for (const message of messages) {
    try {
      results.push(await adapter.send(withEmailHeaders(message)));
    } catch (error) {
      results.push({
        ok: false,
        error: `寄送呼叫失敗（結果不明）：${(error as Error).message}`,
        retryable: false,
        outcomeUnknown: true,
      });
    }
  }
  return results;
}

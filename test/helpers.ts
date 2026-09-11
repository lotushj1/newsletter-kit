import type { Config } from '../src/config.js';
import type { EmailAdapter, EmailMessage, SendResult } from '../src/email/types.js';
import type { ServiceContext } from '../src/services/context.js';
import { MemoryStore } from '../src/store/memory-store.js';

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    publicBaseUrl: 'https://newsletter.test',
    siteName: '測試電子報',
    appSecret: 'test-secret',
    adminToken: 'test-admin-token',
    store: { driver: 'memory', path: ':memory:' },
    email: {
      provider: 'dry_run',
      from: 'Test <test@example.com>',
      replyTo: undefined,
      webhookUrl: undefined,
      webhookSecret: undefined,
      resendApiKey: undefined,
      zeaburEndpoint: undefined,
      zeaburToken: undefined,
    },
    doubleOptIn: true,
    corsOrigins: ['*'],
    publicRateLimitPerMin: 100,
    send: { batchSize: 2, batchDelayMs: 0, maxAttempts: 2 },
    scheduler: { enabled: false, pollMs: 1000 },
    isProduction: false,
    warnings: [],
    ...overrides,
  };
}

export interface FakeAdapter extends EmailAdapter {
  sent: EmailMessage[];
  /** 回傳 null 代表成功，回傳物件代表這次失敗 */
  behavior: (message: EmailMessage, attempt: number) => SendResult | null;
}

export function fakeAdapter(): FakeAdapter {
  const sent: EmailMessage[] = [];
  const attempts = new Map<string, number>();
  const adapter: FakeAdapter = {
    name: 'fake',
    sent,
    behavior: () => null,
    async verify() {
      return { ok: true, message: 'fake adapter' };
    },
    async send(message) {
      const attempt = (attempts.get(message.to) ?? 0) + 1;
      attempts.set(message.to, attempt);
      const failure = adapter.behavior(message, attempt);
      if (failure) return failure;
      sent.push(message);
      return { ok: true, id: `fake_${sent.length}` };
    },
  };
  return adapter;
}

export async function makeContext(
  overrides: Partial<Config> = {},
): Promise<{ ctx: ServiceContext; adapter: FakeAdapter; store: MemoryStore }> {
  const store = new MemoryStore();
  await store.init();
  const adapter = fakeAdapter();
  return { ctx: { config: testConfig(overrides), store, adapter }, adapter, store };
}

/** 從 fake adapter 寄出的確認信裡把 token 撈出來。 */
export function tokenFromEmail(html: string, path: 'confirm' | 'unsubscribe'): string {
  const match = new RegExp(`/${path}\\?token=([^"'\\s&)]+)`).exec(html);
  if (!match?.[1]) throw new Error(`信件內容找不到 ${path} 連結`);
  return decodeURIComponent(match[1]);
}

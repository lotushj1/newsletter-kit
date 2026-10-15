import { afterEach, expect, it } from 'vitest';
import { createResendAdapter } from '../src/email/adapters/resend.js';
import { createZeaburAdapter } from '../src/email/adapters/zeabur.js';
import { createWebhookAdapter } from '../src/email/adapters/webhook.js';
import { createDryRunAdapter } from '../src/email/adapters/dry-run.js';
import { createSesAdapter } from '../src/email/adapters/ses.js';
import { withEmailHeaders } from '../src/email/headers.js';

const message = withEmailHeaders({ to: 'reader@example.com', from: 'News <hi@example.com>', subject: 'Hello', html: '<p>Hi</p>', unsubscribeUrl: 'https://newsletter.test/unsubscribe?token=abc' });
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

it('Resend, Zeabur, and webhook carry both one-click headers in outbound payloads', async () => {
  const bodies: unknown[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ id: 'id' }), { status: 200 });
  }) as typeof fetch;
  const adapters = [
    createResendAdapter({ provider: 'resend', resendApiKey: 'key' }),
    createZeaburAdapter({ provider: 'zeabur', zeaburEndpoint: 'https://relay.test' }),
    createWebhookAdapter({ provider: 'webhook', webhookUrl: 'https://relay.test' }),
  ];
  for (const adapter of adapters) expect((await adapter.send(message)).ok).toBe(true);
  for (const body of bodies) {
    expect(body).toHaveProperty('headers.List-Unsubscribe', '<https://newsletter.test/unsubscribe?token=abc>');
    expect(body).toHaveProperty('headers.List-Unsubscribe-Post', 'List-Unsubscribe=One-Click');
  }
});

it('dry-run accepts prepared headers, while the SES stub still fails', async () => {
  expect((await createDryRunAdapter({ provider: 'dry_run' }).send(message)).ok).toBe(true);
  expect(await createSesAdapter({ provider: 'ses' }).send(message)).toMatchObject({ ok: false, retryable: false });
});

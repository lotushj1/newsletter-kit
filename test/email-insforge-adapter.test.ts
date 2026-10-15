import { afterEach, expect, it, vi } from 'vitest';

const sendEmail = vi.hoisted(() => vi.fn(async () => ({ id: 'insforge-message' })));
vi.mock('../src/core/insforge.js', () => ({
  createInsForgeBackend: () => ({ sendEmail }),
}));

import { createInsForgeAdapter } from '../src/email/adapters/insforge.js';

afterEach(() => vi.restoreAllMocks());

it('InsForge sends unsubscribe messages without custom headers and warns only once', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const adapter = createInsForgeAdapter({
    provider: 'insforge',
    insforgeUrl: 'https://insforge.test',
    insforgeApiKey: 'key',
  });
  const message = {
    to: 'reader@example.com',
    from: 'News <hi@example.com>',
    subject: 'Hello',
    html: '<p>Hi</p><a href="https://newsletter.test/unsubscribe?token=abc">Unsubscribe</a>',
    unsubscribeUrl: 'https://newsletter.test/unsubscribe?token=abc',
  };

  expect(await adapter.send(message)).toEqual({ ok: true, id: 'insforge-message' });
  expect(await createInsForgeAdapter({
    provider: 'insforge',
    insforgeUrl: 'https://insforge.test',
    insforgeApiKey: 'key',
  }).send(message)).toEqual({ ok: true, id: 'insforge-message' });
  expect(sendEmail).toHaveBeenCalledTimes(2);
  expect(sendEmail).toHaveBeenCalledWith({
    to: message.to,
    from: message.from,
    subject: message.subject,
    html: message.html,
    replyTo: undefined,
  });
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('一鍵退訂不可用'));
});

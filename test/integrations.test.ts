import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/http/app.js';
import { applyStoredIntegrations } from '../src/services/integrations.js';
import type { ServiceContext } from '../src/services/context.js';
import { makeContext, testConfig } from './helpers.js';

describe('後台整合設定', () => {
  let server: Server;
  let base: string;
  let ctx: ServiceContext;

  beforeAll(async () => {
    const made = await makeContext();
    ctx = made.ctx;
    ctx.config.email.resendApiKey = 're_supersecret';
    ctx.config.ai.apiKey = 'sk-supersecret';
    server = createApp(ctx).listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const admin = (path: string, options: RequestInit = {}) =>
    fetch(base + path, {
      ...options,
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer test-admin-token',
        ...(options.headers ?? {}),
      },
    });

  it('讀取設定時不回傳金鑰', async () => {
    const response = await admin('/api/admin/integrations');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.email.resendApiKeySet).toBe(true);
    expect(body.ai.apiKeySet).toBe(true);
    expect(JSON.stringify(body)).not.toContain('re_supersecret');
    expect(JSON.stringify(body)).not.toContain('sk-supersecret');
  });

  it('可以改寄信管道，留空的金鑰會沿用', async () => {
    const saved = await admin('/api/admin/integrations/email', {
      method: 'PATCH',
      body: JSON.stringify({
        provider: 'resend',
        from: 'News <news@example.com>',
        replyTo: '',
        resendApiKey: 're_newkey',
      }),
    });
    expect(saved.status).toBe(200);
    const first = await saved.json();
    expect(first.email.provider).toBe('resend');
    expect(first.email.resendApiKeySet).toBe(true);
    expect(JSON.stringify(first)).not.toContain('re_newkey');

    const session = await admin('/api/admin/session');
    expect((await session.json()).provider).toBe('resend');

    const kept = await admin('/api/admin/integrations/email', {
      method: 'PATCH',
      body: JSON.stringify({
        provider: 'resend',
        from: 'News <news@example.com>',
        resendApiKey: '',
      }),
    });
    expect(kept.status).toBe(200);
    expect(ctx.config.email.resendApiKey).toBe('re_newkey');

    const fresh = testConfig();
    await applyStoredIntegrations(fresh, ctx.store);
    expect(fresh.email.provider).toBe('resend');
    expect(fresh.email.resendApiKey).toBe('re_newkey');
    expect(fresh.email.from).toBe('News <news@example.com>');
  });

  it('AI 可以接上，相容服務缺網址會被拒絕，金鑰不回傳', async () => {
    const missing = await admin('/api/admin/integrations/ai', {
      method: 'PATCH',
      body: JSON.stringify({ provider: 'compatible', model: 'llama', baseUrl: '' }),
    });
    expect(missing.status).toBe(400);

    const saved = await admin('/api/admin/integrations/ai', {
      method: 'PATCH',
      body: JSON.stringify({ provider: 'openai', apiKey: 'sk-live', model: '' }),
    });
    expect(saved.status).toBe(200);
    const body = await saved.json();
    expect(body.ai).toMatchObject({ provider: 'openai', configured: true, apiKeySet: true, model: 'gpt-4o-mini' });
    expect(JSON.stringify(body)).not.toContain('sk-live');

    const detected = await admin('/api/admin/integrations/ai', {
      method: 'PATCH',
      body: JSON.stringify({ provider: 'openai', apiKey: 'sk-ant-live', model: 'gpt-4o-mini' }),
    });
    expect(detected.status).toBe(200);
    expect((await detected.json()).ai).toMatchObject({
      provider: 'anthropic',
      model: 'claude-3-5-haiku-latest',
      configured: true,
    });

    const groq = await admin('/api/admin/integrations/ai', {
      method: 'PATCH',
      body: JSON.stringify({ provider: 'openai', apiKey: 'gsk_live', model: '' }),
    });
    expect(groq.status).toBe(200);
    expect((await groq.json()).ai).toMatchObject({
      provider: 'groq',
      model: 'llama-3.3-70b-versatile',
      baseUrl: 'https://api.groq.com/openai/v1',
      configured: true,
    });

    const ambiguous = await admin('/api/admin/integrations/ai', {
      method: 'PATCH',
      body: JSON.stringify({ provider: 'deepseek', apiKey: 'sk-plain', model: '' }),
    });
    expect(ambiguous.status).toBe(200);
    expect((await ambiguous.json()).ai).toMatchObject({
      provider: 'deepseek',
      model: 'deepseek-chat',
      configured: true,
    });

    const choices = await admin('/api/admin/integrations');
    const listed = (await choices.json()).ai.choices as { id: string }[];
    expect(listed.map((item) => item.id)).toContain('gemini');
    expect(listed.map((item) => item.id)).not.toContain('compatible');

    const off = await admin('/api/admin/integrations/ai', {
      method: 'PATCH',
      body: JSON.stringify({ provider: 'none' }),
    });
    expect(off.status).toBe(200);
    expect((await off.json()).ai.configured).toBe(false);
    expect((await admin('/api/admin/session').then((response) => response.json())).ai.configured).toBe(false);
  });

  it('常用和較少用的寄信平台可儲存，金鑰不回傳', async () => {
    const listed = await admin('/api/admin/integrations');
    const choices = (await listed.json()).email.choices as { id: string; group: string }[];
    expect(choices.filter((item) => item.group === 'common').map((item) => item.id)).toContain('postmark');
    expect(choices.filter((item) => item.group === 'more').map((item) => item.id)).toContain('postal');

    const saved = await admin('/api/admin/integrations/email', {
      method: 'PATCH',
      body: JSON.stringify({
        provider: 'mailgun',
        from: 'News <news@example.com>',
        apiKey: 'mg-secret',
        apiExtra: 'mg.example.com',
      }),
    });
    expect(saved.status).toBe(200);
    const body = await saved.json();
    expect(body.email.provider).toBe('mailgun');
    expect(JSON.stringify(body)).not.toContain('mg-secret');
    const mailgun = body.email.choices.find((item: { id: string }) => item.id === 'mailgun');
    expect(mailgun).toMatchObject({ keySet: true, extra: 'mg.example.com' });

    const bad = await admin('/api/admin/integrations/email', {
      method: 'PATCH',
      body: JSON.stringify({
        provider: 'postal',
        from: 'News <news@example.com>',
        apiKey: 'postal-secret',
        apiExtra: 'postal.example.com',
      }),
    });
    expect(bad.status).toBe(400);

    await admin('/api/admin/integrations/email', {
      method: 'PATCH',
      body: JSON.stringify({ provider: 'dry_run', from: 'News <news@example.com>' }),
    });
  });
});

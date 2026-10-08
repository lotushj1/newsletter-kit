import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAiAdapter } from '../src/ai/registry.js';
import { detectAiProvider } from '../src/ai/providers.js';
import type { AiAdapter, AiCompleteInput } from '../src/ai/types.js';
import { createApp } from '../src/http/app.js';
import { createSubscriber } from '../src/services/subscribers.js';
import type { ServiceContext } from '../src/services/context.js';
import { makeContext } from './helpers.js';

function listen(ctx: ServiceContext): Promise<{ server: Server; base: string }> {
  const server = createApp(ctx).listen(0);
  return new Promise((resolve) => {
    server.once('listening', () => {
      resolve({ server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    });
  });
}

function admin(base: string, path: string, options: RequestInit = {}) {
  return fetch(base + path, {
    ...options,
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer test-admin-token',
      ...(options.headers ?? {}),
    },
  });
}

describe('尚未接上 AI', () => {
  let server: Server;
  let base: string;
  let ctx: ServiceContext;

  beforeAll(async () => {
    const made = await makeContext();
    ctx = made.ctx;
    ctx.config.ai = {
      provider: 'openai',
      apiKey: 'sk-test-secret',
      model: 'gpt-4o-mini',
      baseUrl: undefined,
    };
    const started = await listen(ctx);
    server = started.server;
    base = started.base;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('任務回 400，設定摘要不含金鑰', async () => {
    const draft = await admin(base, '/api/admin/ai/draft', {
      method: 'POST',
      body: JSON.stringify({ brief: '寫一封信' }),
    });
    expect(draft.status).toBe(400);
    expect((await draft.json()).error).toContain('尚未接上 AI');

    const verify = await admin(base, '/api/admin/ai/verify');
    expect(verify.status).toBe(200);
    expect(await verify.json()).toMatchObject({ ok: false, message: '尚未接上 AI' });

    const session = await admin(base, '/api/admin/session');
    const body = await session.json();
    expect(body.ai).toEqual({ configured: false, provider: 'openai', label: 'OpenAI', model: 'gpt-4o-mini', writes: false });
    expect(JSON.stringify(body)).not.toContain('sk-test-secret');
  });

  it('設定不齊時 adapter 是空的', async () => {
    expect(createAiAdapter({ provider: 'none', apiKey: 'k', model: 'm', baseUrl: undefined })).toBeNull();
    expect(createAiAdapter({ provider: 'openai', apiKey: undefined, model: 'm', baseUrl: undefined })).toBeNull();
    expect(
      createAiAdapter({ provider: 'compatible', apiKey: 'k', model: 'm', baseUrl: undefined }),
    ).toBeNull();
    expect(createAiAdapter({ provider: 'groq', apiKey: 'gsk_x', model: undefined, baseUrl: undefined })).toMatchObject({
      name: 'groq',
      model: 'llama-3.3-70b-versatile',
    });
    expect(createAiAdapter({ provider: 'ollama', apiKey: undefined, model: undefined, baseUrl: undefined })?.model).toBe('llama3.2');
    expect(detectAiProvider('sk-ant-abc')).toBe('anthropic');
    expect(detectAiProvider('gsk_abc')).toBe('groq');
    expect(detectAiProvider('sk-not-specific')).toBeNull();
    const jev = createAiAdapter({ provider: 'jev', apiKey: 'key', model: undefined, baseUrl: undefined });
    expect(jev).toMatchObject({ name: 'jev', model: 'jev-latest' });
    await expect(jev?.complete({ system: '', user: '', schema: {} })).rejects.toThrow('不能寫信');
    const previous = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({
        answers: {
          status: { type: 'choice', choice: 'subscribed' },
          search: { type: 'noul', noul: 0.2 },
        },
      }), { status: 200 });
    try {
      const answers = await jev?.decide?.('已訂閱的人', [
        { id: 'status', instructions: '狀態', options: { none: '不限', subscribed: '已訂閱' } },
        { id: 'search', instructions: '還需要關鍵字' },
      ]);
      expect(answers?.status).toEqual({ choice: 'subscribed', yes: false });
      expect(answers?.search.yes).toBe(false);
    } finally {
      globalThis.fetch = previous;
    }
  });
});

describe('假 AI adapter', () => {
  let server: Server;
  let base: string;
  let ctx: ServiceContext;
  const queue: unknown[] = [];
  const prompts: string[] = [];

  const ai: AiAdapter = {
    name: 'fake',
    model: 'fake-model',
    async verify() {
      return { ok: true, message: '已接上 fake' };
    },
    async complete(input: AiCompleteInput) {
      prompts.push(input.user);
      const next = queue.shift();
      if (next === undefined) throw new Error('沒有下一個假回應');
      return next;
    },
  };

  beforeAll(async () => {
    const made = await makeContext();
    ctx = made.ctx;
    ctx.ai = ai;
    ctx.config.ai = { provider: 'openai', apiKey: 'sk-test-secret', model: 'fake-model', baseUrl: undefined };
    const started = await listen(ctx);
    server = started.server;
    base = started.base;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    queue.length = 0;
    prompts.length = 0;
  });

  it('起草、改寫、篩選、序列草稿的格式不對會被拒絕', async () => {
    queue.push({ preheader: 'x' });
    const draft = await admin(base, '/api/admin/ai/draft', {
      method: 'POST',
      body: JSON.stringify({ brief: '題材' }),
    });
    expect(draft.status).toBe(400);

    queue.push({});
    const rewrite = await admin(base, '/api/admin/ai/rewrite', {
      method: 'POST',
      body: JSON.stringify({ html: '<p>原文</p>', instruction: '縮短' }),
    });
    expect(rewrite.status).toBe(400);

    queue.push({ status: 'opened', explanation: '', unsupported: '' });
    const filter = await admin(base, '/api/admin/ai/filter', {
      method: 'POST',
      body: JSON.stringify({ scope: 'subscribers', prompt: '上次有開信的人' }),
    });
    expect(filter.status).toBe(400);

    queue.push({ name: '壞掉', trigger: 'subscribe', steps: [{ delayDays: 100, title: '太遠', bodyHtml: '<p>x</p>' }] });
    const automation = await admin(base, '/api/admin/ai/automation', {
      method: 'POST',
      body: JSON.stringify({ goal: '一年後寄一封' }),
    });
    expect(automation.status).toBe(400);
  });

  it('寄送對象不能是待確認', async () => {
    queue.push({ status: 'pending', folderId: '', explanation: '待確認', unsupported: '' });
    const response = await admin(base, '/api/admin/ai/filter', {
      method: 'POST',
      body: JSON.stringify({ scope: 'audience', prompt: '寄給待確認的人' }),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('待確認');
  });

  it('套用自動化時序列是停用的', async () => {
    const draft = {
      name: '歡迎信',
      trigger: 'subscribe',
      triggerValue: '',
      enabled: true,
      steps: [{ delayDays: 0, title: '第一封', preheader: '嗨', bodyHtml: '<p>你好</p>' }],
    };
    const response = await admin(base, '/api/admin/ai/automation/apply', {
      method: 'POST',
      body: JSON.stringify(draft),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { sequence: { id: string; enabled: boolean; name: string } };
    expect(body.sequence.enabled).toBe(false);
    expect(body.sequence.name).toBe('歡迎信');

    const stored = await ctx.store.getSequence(body.sequence.id);
    expect(stored?.enabled).toBe(false);
  });

  it('整理建議不改 Email 或狀態，也不把 Email 送給模型', async () => {
    const person = await createSubscriber(ctx, {
      email: 'organize-me@example.com',
      name: '整理對象',
      status: 'subscribed',
    });
    queue.push({
      suggestions: [
        {
          id: person.id,
          tags: ['vip'],
          folderId: '',
          note: '加上標籤',
          email: 'changed@example.com',
          status: 'unsubscribed',
        },
      ],
    });
    const response = await admin(base, '/api/admin/ai/organize-subscribers', {
      method: 'POST',
      body: JSON.stringify({ ids: [person.id] }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      suggestions: { id: string; tags?: string[]; folderId: string | null; note: string; email?: string; status?: string }[];
    };
    expect(body.suggestions).toEqual([
      { id: person.id, tags: ['vip'], folderId: null, note: '加上標籤' },
    ]);
    expect(prompts[0]).not.toContain('organize-me@example.com');
    expect(prompts[0]).toContain('整理對象');

    const stored = await ctx.store.getSubscriber(person.id);
    expect(stored?.email).toBe('organize-me@example.com');
    expect(stored?.status).toBe('subscribed');
    expect(stored?.tags).toEqual([]);
  });
});

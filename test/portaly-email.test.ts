import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  batchIdempotencyKey,
  createPortalyAdapter,
  portalyEmailPayload,
  sanitizeIdempotencyKey,
} from '../src/email/adapters/portaly.ts';
import { createEmailAdapter, listEmailAdapters } from '../src/email/registry.ts';
import { getEmailPlatform } from '../src/email/providers.ts';
import { syncPortalyDeliveries } from '../src/services/portaly-sync.ts';
import type { AdapterContext, EmailMessage } from '../src/email/types.ts';
import { makeContext } from './helpers.ts';

const message: EmailMessage = {
  to: 'reader@example.com',
  from: 'News <news@example.com>',
  replyTo: 'hello@example.com',
  subject: '你好',
  html: '<p>嗨</p>',
  text: '嗨',
  unsubscribeUrl: 'https://newsletter.test/unsubscribe?token=abc',
  idempotencyKey: 'dlv_0001',
};

function context(overrides: Partial<AdapterContext> = {}): AdapterContext {
  return { provider: 'portaly', portalyApiKey: 'pem_test_key', ...overrides };
}

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function stubFetch(
  respond: (captured: Captured, call: number) => { status: number; body: unknown; headers?: Record<string, string> },
): Captured[] {
  const calls: Captured[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const captured: Captured = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
      ),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(captured);
    const reply = respond(captured, calls.length);
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'content-type': 'application/json', ...(reply.headers ?? {}) },
    });
  }) as typeof fetch;
  return calls;
}

let originalFetch: typeof fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('Portaly 平台註冊', () => {
  it('portaly 在 adapter 清單與平台清單裡', () => {
    expect(listEmailAdapters()).toContain('portaly');
    const platform = getEmailPlatform('portaly');
    expect(platform?.kind).toBe('portaly');
    expect(platform?.group).toBe('common');
  });

  it('createEmailAdapter 能建立 portaly adapter', () => {
    expect(createEmailAdapter(context()).name).toBe('portaly');
  });
});

describe('Portaly 請求內容', () => {
  it('payload 帶 sender、單一收件人、退訂 header 與 ref tag', () => {
    const payload = portalyEmailPayload(message, 'dlv_0001');
    expect(payload).toMatchObject({
      sender: { email: 'news@example.com', name: 'News' },
      recipients: [{ email: 'reader@example.com' }],
      replyTo: 'hello@example.com',
      subject: '你好',
      tags: [{ name: 'ref', value: 'dlv_0001' }],
    });
    expect(payload.headers).toMatchObject({
      'List-Unsubscribe': '<https://newsletter.test/unsubscribe?token=abc>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
  });

  it('冪等鍵只留英數底線連字號', () => {
    expect(sanitizeIdempotencyKey('dlv_abc')).toBe('dlv_abc');
    expect(sanitizeIdempotencyKey('a@b c/d')).toBe('a-b-c-d');
  });

  it('send 打 /api/email/emails、帶 Bearer 與 Idempotency-Key，金鑰不進網址', async () => {
    const calls = stubFetch(() => ({ status: 200, body: { data: { id: 'emsg_1' } } }));
    const result = await createPortalyAdapter(context()).send(message);
    expect(result).toEqual({ ok: true, id: 'emsg_1' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: 'https://portaly.ai/api/email/emails',
      method: 'POST',
      headers: {
        authorization: 'Bearer pem_test_key',
        'idempotency-key': 'dlv_0001',
      },
    });
    expect(calls[0]!.url).not.toContain('pem_test_key');
  });

  it('PORTALY_API_HOST 可以覆寫位址', async () => {
    const calls = stubFetch(() => ({ status: 200, body: { data: { id: 'emsg_1' } } }));
    await createPortalyAdapter(context({ portalyApiHost: 'https://staging.portaly.test/' })).send(message);
    expect(calls[0]!.url).toBe('https://staging.portaly.test/api/email/emails');
  });

  it('沒有金鑰時不打 API，直接回設定錯誤', async () => {
    const calls = stubFetch(() => ({ status: 200, body: {} }));
    const result = await createPortalyAdapter(context({ portalyApiKey: undefined })).send(message);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('PORTALY_EMAIL_API_KEY');
      expect(result.retryable).toBe(false);
    }
    expect(calls).toHaveLength(0);
  });
});

describe('Portaly 錯誤處理', () => {
  it('403 FORBIDDEN（未開通 beta）不重試，錯誤訊息講清楚', async () => {
    stubFetch(() => ({ status: 403, body: { error: { code: 'FORBIDDEN', message: 'beta only' } } }));
    const result = await createPortalyAdapter(context()).send(message);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(false);
      expect(result.error).toContain('邀請制 beta');
    }
  });

  it('429 SEND_QUOTA_EXCEEDED 不重試（額度不足重試沒用）', async () => {
    stubFetch(() => ({ status: 429, body: { error: { code: 'SEND_QUOTA_EXCEEDED', message: 'quota' } } }));
    const result = await createPortalyAdapter(context()).send(message);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(false);
      expect(result.error).toContain('額度');
    }
  });

  it('429 RATE_LIMITED 依 Retry-After 原鍵重試，之後成功', async () => {
    const calls = stubFetch((_, call) =>
      call === 1
        ? { status: 429, body: { error: { code: 'RATE_LIMITED', message: 'slow down' } }, headers: { 'retry-after': '0' } }
        : { status: 200, body: { data: { id: 'emsg_retry' } } },
    );
    const result = await createPortalyAdapter(context()).send(message);
    expect(result).toEqual({ ok: true, id: 'emsg_retry' });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.headers['idempotency-key']).toBe(calls[1]!.headers['idempotency-key']);
  });

  it('502 SEND_OUTCOME_UNKNOWN 標記可重試（同鍵重試不會寄兩次）', async () => {
    stubFetch(() => ({ status: 502, body: { error: { code: 'SEND_OUTCOME_UNKNOWN', message: '' } } }));
    const result = await createPortalyAdapter(context()).send(message);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.retryable).toBe(true);
  });

  it('409 IDEMPOTENCY_KEY_IN_USE 標記可重試', async () => {
    stubFetch(() => ({ status: 409, body: { error: { code: 'IDEMPOTENCY_KEY_IN_USE', message: '' } } }));
    const result = await createPortalyAdapter(context()).send(message);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.retryable).toBe(true);
  });
});

describe('Portaly 批次寄送', () => {
  const second: EmailMessage = { ...message, to: 'two@example.com', idempotencyKey: 'dlv_0002' };

  it('多封走 /api/email/batches，依序對回 id', async () => {
    const calls = stubFetch(() => ({
      status: 202,
      body: { data: { batchId: 'ebat_1', emails: [{ id: 'emsg_a' }, { id: 'emsg_b' }] } },
    }));
    const adapter = createPortalyAdapter(context());
    const results = await adapter.sendBatch!([message, second]);
    expect(results).toEqual([
      { ok: true, id: 'emsg_a' },
      { ok: true, id: 'emsg_b' },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://portaly.ai/api/email/batches');
    const body = calls[0]!.body as { emails: { idempotencyKey?: string }[] };
    expect(body.emails).toHaveLength(2);
    // 批次內不能帶單封的 idempotencyKey，鍵掛在整個批次的 header 上
    expect(body.emails[0]!.idempotencyKey).toBeUndefined();
    expect(calls[0]!.headers['idempotency-key']).toBe(batchIdempotencyKey(['dlv_0001', 'dlv_0002']));
  });

  it('同一組訊息重試會用同一個批次冪等鍵', () => {
    expect(batchIdempotencyKey(['a', 'b'])).toBe(batchIdempotencyKey(['a', 'b']));
    expect(batchIdempotencyKey(['a', 'b'])).not.toBe(batchIdempotencyKey(['a', 'c']));
  });

  it('批次整批被拒時，每封都拿到同樣的失敗結果', async () => {
    stubFetch(() => ({ status: 429, body: { error: { code: 'SEND_QUOTA_EXCEEDED', message: 'quota' } } }));
    const adapter = createPortalyAdapter(context());
    const results = await adapter.sendBatch!([message, second]);
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.retryable).toBe(false);
    }
  });

  it('只有一封時走單封端點', async () => {
    const calls = stubFetch(() => ({ status: 200, body: { data: { id: 'emsg_only' } } }));
    const adapter = createPortalyAdapter(context());
    const results = await adapter.sendBatch!([message]);
    expect(results).toEqual([{ ok: true, id: 'emsg_only' }]);
    expect(calls[0]!.url).toBe('https://portaly.ai/api/email/emails');
  });
});

describe('Portaly verify', () => {
  it('用 /api/email/quota 檢查金鑰並回報剩餘額度', async () => {
    const calls = stubFetch(() => ({
      status: 200,
      body: { data: { remaining: 1950, monthlyAllowance: 2000, sandboxRemainingToday: 48 } },
    }));
    const result = await createPortalyAdapter(context()).verify();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('1950');
    expect(result.message).toContain('48');
    expect(calls[0]!.url).toBe('https://portaly.ai/api/email/quota');
  });

  it('401 時提示金鑰無效', async () => {
    stubFetch(() => ({ status: 401, body: { error: { code: 'INVALID_API_KEY', message: 'nope' } } }));
    const result = await createPortalyAdapter(context()).verify();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('金鑰');
  });

  it('沒設定金鑰時附上建立金鑰的網址', async () => {
    const result = await createPortalyAdapter(context({ portalyApiKey: undefined })).verify();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('https://portaly.cc/admin/email/api-keys');
  });
});

describe('Portaly 投遞狀態回查', () => {
  it('退信標成 bounced、檢舉視同退訂，寄送紀錄同步更新', async () => {
    const { ctx, store } = await makeContext();
    ctx.config.email.provider = 'portaly';
    ctx.config.email.portalyApiKey = 'pem_test_key';

    const bounced = await store.createSubscriber({
      id: 'sub_b', email: 'bounce@example.com', status: 'subscribed', tags: [], createdAt: new Date().toISOString(),
    });
    const complained = await store.createSubscriber({
      id: 'sub_c', email: 'complain@example.com', status: 'subscribed', tags: [], createdAt: new Date().toISOString(),
    });
    await store.createDeliveries([
      { id: 'dlv_b', campaignId: 'cmp_1', subscriberId: bounced.id, email: bounced.email, status: 'sent', attempts: 1, providerMessageId: 'emsg_b' },
      { id: 'dlv_c', campaignId: 'cmp_1', subscriberId: complained.id, email: complained.email, status: 'sent', attempts: 1, providerMessageId: 'emsg_c' },
    ]);

    const calls = stubFetch(() => ({
      status: 200,
      body: {
        data: [
          { id: 'emsg_b', recipients: [{ status: 'bounced' }] },
          { id: 'emsg_c', recipients: [{ status: 'complained' }] },
          { id: 'emsg_unknown', recipients: [{ status: 'bounced' }] },
        ],
        pagination: { hasMore: false },
      },
    }));

    const summary = await syncPortalyDeliveries(ctx);
    expect(summary).toMatchObject({ ran: true, checked: 3, updated: 2 });
    expect(calls[0]!.url).toContain('/api/email/emails?');
    expect(calls[0]!.url).toContain('recipientStatus=');

    expect((await store.getSubscriber(bounced.id))?.status).toBe('bounced');
    const afterComplaint = await store.getSubscriber(complained.id);
    expect(afterComplaint?.status).toBe('unsubscribed');

    const deliveries = await store.listDeliveries('cmp_1');
    expect(deliveries.find((d) => d.id === 'dlv_b')?.status).toBe('failed');
    // 檢舉代表信有送達，寄送紀錄維持 sent
    expect(deliveries.find((d) => d.id === 'dlv_c')?.status).toBe('sent');
  });

  it('provider 不是 portaly 時不打 API', async () => {
    const { ctx } = await makeContext();
    const calls = stubFetch(() => ({ status: 200, body: { data: [] } }));
    const summary = await syncPortalyDeliveries(ctx);
    expect(summary.ran).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hmacSha256Hex } from '../src/core/tokens.js';
import { ingestSubscriber } from '../src/services/ingest.js';
import { createSubscriber } from '../src/services/subscribers.js';
import { makeContext } from './helpers.js';

describe('簽名匯入', () => {
  it('新 email 直接進名單', async () => {
    const { ctx } = await makeContext();
    const result = await ingestSubscriber(ctx, {
      email: 'new@example.com',
      name: '新人',
      tags: 'design',
      source: 'portaly',
    });
    expect(result.action).toBe('created');
    expect(result.subscriber.status).toBe('subscribed');
    expect(result.subscriber.tags).toContain('design');
  });

  it('重複 email 合併標籤、不重開確認信', async () => {
    const { ctx, adapter } = await makeContext();
    await createSubscriber(ctx, { email: 'old@example.com', tags: 'vip' });
    const before = adapter.sent.length;
    const result = await ingestSubscriber(ctx, {
      email: 'old@example.com',
      tags: ['design'],
    });
    expect(result.action).toBe('updated');
    expect(result.subscriber.tags.sort()).toEqual(['design', 'vip']);
    expect(adapter.sent.length).toBe(before);
  });

  it('HMAC 與 webhook 同一套算法', () => {
    const body = '{"email":"a@example.com"}';
    expect(hmacSha256Hex('ingest-secret', body)).toBe(
      createHmac('sha256', 'ingest-secret').update(body).digest('hex'),
    );
  });
});

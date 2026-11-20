import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ingestSubscriber } from '../src/services/ingest.js';
import { isSuppressed } from '../src/services/suppression.js';
import {
  confirmSubscription,
  createSubscriber,
  deleteSubscriber,
  importSubscribersCsv,
  subscribe,
  unsubscribeByEmail,
  updateSubscriber,
} from '../src/services/subscribers.js';
import { makeContext, tokenFromEmail } from './helpers.js';

const suppressionKey = (email: string) => `suppression:${createHash('sha256').update(email).digest('hex')}`;

async function subscribedViaConfirm(ctx: Awaited<ReturnType<typeof makeContext>>['ctx'], adapter: Awaited<ReturnType<typeof makeContext>>['adapter'], email: string) {
  await subscribe(ctx, { email });
  const token = tokenFromEmail(adapter.sent.at(-1)!.html, 'confirm');
  await confirmSubscription(ctx, token);
  return token;
}

describe('退訂一律留下排除紀錄', () => {
  it('名單裡的人退訂後，排除名單也有記錄', async () => {
    const { ctx, adapter } = await makeContext();
    await subscribedViaConfirm(ctx, adapter, 'a@example.com');
    await unsubscribeByEmail(ctx, 'a@example.com');
    expect(await ctx.store.getSetting(suppressionKey('a@example.com'))).toBe('unsubscribe');
  });

  it('退訂後被刪除、再用 CSV 匯入：會建檔但維持退訂，不會被寄送', async () => {
    const { ctx, adapter } = await makeContext();
    await subscribedViaConfirm(ctx, adapter, 'a@example.com');
    await unsubscribeByEmail(ctx, 'a@example.com');
    await deleteSubscriber(ctx, (await ctx.store.getSubscriberByEmail('a@example.com'))!.id);

    const result = await importSubscribersCsv(ctx, 'email\na@example.com\nb@example.com\n');
    expect(result).toMatchObject({ created: 2, suppressed: 1 });
    expect(result.errors.join('')).toContain('退訂');
    expect((await ctx.store.getSubscriberByEmail('a@example.com'))?.status).toBe('unsubscribed');
    expect((await ctx.store.getSubscriberByEmail('b@example.com'))?.status).toBe('subscribed');
  });

  it('舊資料：退訂了但沒有排除紀錄的人被刪除時，會先補上紀錄', async () => {
    const { ctx, store } = await makeContext();
    await store.createSubscriber({ id: 'sub_legacy', email: 'old@example.com', status: 'unsubscribed', tags: [], createdAt: '2026-01-01T00:00:00.000Z' });
    await deleteSubscriber(ctx, 'sub_legacy');
    expect(await isSuppressed(ctx, 'old@example.com')).toBe(true);
    await importSubscribersCsv(ctx, 'email\nold@example.com\n');
    expect((await ctx.store.getSubscriberByEmail('old@example.com'))?.status).toBe('unsubscribed');
  });

  it('退信的人被刪除後再匯入，維持退信狀態', async () => {
    const { ctx, store } = await makeContext();
    await store.createSubscriber({ id: 'sub_b', email: 'gone@example.com', status: 'bounced', tags: [], createdAt: '2026-01-01T00:00:00.000Z' });
    await deleteSubscriber(ctx, 'sub_b');
    await importSubscribersCsv(ctx, 'email\ngone@example.com\n');
    expect((await ctx.store.getSubscriberByEmail('gone@example.com'))?.status).toBe('bounced');
  });

  it('簽名匯入（ingest）遇到退訂過的地址：建檔但不加入寄送', async () => {
    const { ctx, adapter } = await makeContext();
    await subscribedViaConfirm(ctx, adapter, 'a@example.com');
    await unsubscribeByEmail(ctx, 'a@example.com');
    await deleteSubscriber(ctx, (await ctx.store.getSubscriberByEmail('a@example.com'))!.id);
    const { subscriber } = await ingestSubscriber(ctx, { email: 'a@example.com' });
    expect(subscriber.status).toBe('unsubscribed');
  });
});

describe('退訂只能由本人重新確認來解除', () => {
  it('確認信寄出後才退訂的人，點舊確認連結不會被加回', async () => {
    const { ctx, adapter } = await makeContext();
    await subscribe(ctx, { email: 'a@example.com' });
    const oldToken = tokenFromEmail(adapter.sent[0]!.html, 'confirm');
    await confirmSubscription(ctx, oldToken);
    await unsubscribeByEmail(ctx, 'a@example.com');

    const again = await confirmSubscription(ctx, oldToken);
    expect(again.ok).toBe(false);
    expect((await ctx.store.getSubscriberByEmail('a@example.com'))?.status).toBe('unsubscribed');
    expect(await isSuppressed(ctx, 'a@example.com')).toBe(true);
  });

  it('退訂後重新填表、點新的確認信，就恢復訂閱並解除排除', async () => {
    const { ctx, adapter } = await makeContext();
    await subscribedViaConfirm(ctx, adapter, 'a@example.com');
    await unsubscribeByEmail(ctx, 'a@example.com');
    await subscribedViaConfirm(ctx, adapter, 'a@example.com');
    expect((await ctx.store.getSubscriberByEmail('a@example.com'))?.status).toBe('subscribed');
    expect(await isSuppressed(ctx, 'a@example.com')).toBe(false);
  });

  it('單次同意的來源：退訂過的人重新填表仍要點確認信', async () => {
    const { ctx, adapter } = await makeContext({ doubleOptIn: false });
    await subscribe(ctx, { email: 'a@example.com' });
    await unsubscribeByEmail(ctx, 'a@example.com');
    adapter.sent.length = 0;
    const outcome = await subscribe(ctx, { email: 'a@example.com' });
    expect(outcome.status).toBe('pending');
    expect(adapter.sent).toHaveLength(1);
  });

  it('單次同意的來源：退訂後被刪除的人重新填表也要確認', async () => {
    const { ctx, adapter } = await makeContext({ doubleOptIn: false });
    await subscribe(ctx, { email: 'a@example.com' });
    await unsubscribeByEmail(ctx, 'a@example.com');
    await deleteSubscriber(ctx, (await ctx.store.getSubscriberByEmail('a@example.com'))!.id);
    const outcome = await subscribe(ctx, { email: 'a@example.com' });
    expect(outcome.status).toBe('pending');
    expect(adapter.sent).toHaveLength(1);
  });

  it('後台不能把退訂或退信的人直接改回已訂閱，也不能新增排除名單上的地址為已訂閱', async () => {
    const { ctx, adapter } = await makeContext();
    await subscribedViaConfirm(ctx, adapter, 'a@example.com');
    await unsubscribeByEmail(ctx, 'a@example.com');
    const id = (await ctx.store.getSubscriberByEmail('a@example.com'))!.id;
    await expect(updateSubscriber(ctx, id, { status: 'subscribed' })).rejects.toThrow('退訂過');
    await deleteSubscriber(ctx, id);
    await expect(createSubscriber(ctx, { email: 'a@example.com' })).rejects.toThrow('退訂過');

    const bounced = await createSubscriber(ctx, { email: 'b@example.com', status: 'bounced' });
    await expect(updateSubscriber(ctx, bounced.id, { status: 'subscribed' })).rejects.toThrow('退信過');
  });

  it('後台可以把等待確認的人改成已訂閱，並記下是後台操作', async () => {
    const { ctx } = await makeContext();
    await subscribe(ctx, { email: 'a@example.com' });
    const id = (await ctx.store.getSubscriberByEmail('a@example.com'))!.id;
    const updated = await updateSubscriber(ctx, id, { status: 'subscribed' });
    expect(updated.status).toBe('subscribed');
    expect(updated.meta?.consent).toMatchObject({ method: 'admin' });
  });
});

describe('同意紀錄', () => {
  it('double opt-in：記下確認時間、填表時間、來源與說明文字版本', async () => {
    const { ctx, adapter } = await makeContext();
    await subscribe(ctx, { email: 'a@example.com', source: 'join_page' });
    await confirmSubscription(ctx, tokenFromEmail(adapter.sent[0]!.html, 'confirm'));
    const subscriber = (await ctx.store.getSubscriberByEmail('a@example.com'))!;
    expect(subscriber.confirmedAt).toBeTruthy();
    expect(subscriber.meta?.consent).toMatchObject({ method: 'double_opt_in', source: 'join_page' });
    const consent = subscriber.meta?.consent as { requestedAt?: string; textVersion?: string };
    expect(consent.requestedAt).toBeTruthy();
    expect(consent.textVersion).toMatch(/^\d{4}-\d{2}-\d{2}\+[0-9a-f]{8}$/);
    expect(subscriber.meta?.consentRequest).toBeUndefined();
    expect(subscriber.meta?.consentHistory).toHaveLength(1);
  });

  it('CSV 匯入的人沒有點過確認信：不填確認時間，同意來源記為匯入', async () => {
    const { ctx } = await makeContext();
    await importSubscribersCsv(ctx, 'email\na@example.com\n');
    const subscriber = (await ctx.store.getSubscriberByEmail('a@example.com'))!;
    expect(subscriber.status).toBe('subscribed');
    expect(subscriber.confirmedAt).toBeUndefined();
    expect(subscriber.meta?.consent).toMatchObject({ method: 'import', source: 'import' });
  });

  it('確認連結點兩次：第二次只回覆已完成，不重複加入序列', async () => {
    const { ctx, adapter } = await makeContext();
    await subscribe(ctx, { email: 'a@example.com' });
    const token = tokenFromEmail(adapter.sent[0]!.html, 'confirm');
    expect((await confirmSubscription(ctx, token)).ok).toBe(true);
    const second = await confirmSubscription(ctx, token);
    expect(second).toEqual({ ok: true, message: '你已經完成訂閱了。' });
    expect((await ctx.store.getSubscriberByEmail('a@example.com'))?.meta?.consentHistory).toHaveLength(1);
  });

  it('還沒確認時再填一次表單，會重寄確認信，新舊連結都能完成確認', async () => {
    const { ctx, adapter } = await makeContext();
    await subscribe(ctx, { email: 'a@example.com' });
    const first = tokenFromEmail(adapter.sent[0]!.html, 'confirm');
    const again = await subscribe(ctx, { email: 'a@example.com' });
    expect(again.status).toBe('pending');
    expect(adapter.sent).toHaveLength(2);
    expect((await confirmSubscription(ctx, first)).ok).toBe(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('過期或被竄改的確認連結會被拒絕', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { ctx, adapter } = await makeContext();
    await subscribe(ctx, { email: 'a@example.com' });
    const token = tokenFromEmail(adapter.sent[0]!.html, 'confirm');
    expect((await confirmSubscription(ctx, 'not-a-token')).ok).toBe(false);
    vi.setSystemTime(Date.now() + 15 * 24 * 60 * 60 * 1000);
    expect((await confirmSubscription(ctx, token)).ok).toBe(false);
    expect((await ctx.store.getSubscriberByEmail('a@example.com'))?.status).toBe('pending');
  });
});

describe('日誌不留 Email 與 token', () => {
  it('Email 遮成首字加網域，確認連結的 token 與 Bearer 憑證換成 ***', async () => {
    const { redactForLog } = await import('../src/core/logger.js');
    const line = redactForLog(
      '確認信寄送失敗 {"email":"alice.smith@example.com","url":"https://x.test/confirm?token=abc.def&x=1","auth":"Bearer s3cr3t"}',
    );
    expect(line).toContain('a***@example.com');
    expect(line).not.toContain('alice.smith');
    expect(line).toContain('/confirm?token=***&x=1');
    expect(line).toContain('Bearer ***');
    expect(line).not.toContain('s3cr3t');
  });
});

describe('個人資料匯出', () => {
  it('包含訂閱資料、同意紀錄、排除狀態、寄送與開信紀錄，不含 token', async () => {
    const { ctx, adapter } = await makeContext();
    await subscribedViaConfirm(ctx, adapter, 'a@example.com');
    const subscriber = (await ctx.store.getSubscriberByEmail('a@example.com'))!;
    await ctx.store.createDeliveries([
      { id: 'dlv_1', campaignId: 'cmp_1', subscriberId: subscriber.id, email: subscriber.email, status: 'sent', attempts: 1, sentAt: '2026-11-19T00:00:00.000Z' },
    ]);
    await ctx.store.createEvent({ id: 'evt_1', campaignId: 'cmp_1', subscriberId: subscriber.id, deliveryId: 'dlv_1', type: 'open', createdAt: '2026-11-19T01:00:00.000Z' });
    await unsubscribeByEmail(ctx, 'a@example.com');

    const { exportSubscriberData } = await import('../src/services/subscribers.js');
    const data = await exportSubscriberData(ctx, subscriber.id);
    expect(data).toMatchObject({
      suppression: 'unsubscribe',
      deliveries: [{ id: 'dlv_1', status: 'sent' }],
      events: [{ type: 'open', campaignId: 'cmp_1' }],
    });
    expect((data.subscriber as { meta?: { consent?: unknown } }).meta?.consent).toMatchObject({ method: 'double_opt_in' });
    expect(JSON.stringify(data)).not.toContain('token');
  });
});

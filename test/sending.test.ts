import { describe, expect, it } from 'vitest';
import { createCampaign } from '../src/services/campaigns.js';
import { createFolder } from '../src/services/folders.js';
import { createScheduler } from '../src/services/scheduler.js';
import { cancelSending, sendTestEmail, startCampaign } from '../src/services/sending.js';
import { createSubscriber } from '../src/services/subscribers.js';
import { makeContext } from './helpers.js';

async function seedAudience(ctx: Awaited<ReturnType<typeof makeContext>>['ctx']): Promise<void> {
  await createSubscriber(ctx, { email: 'a@example.com', name: '阿明', tags: 'vip' });
  await createSubscriber(ctx, { email: 'b@example.com', name: '小美' });
  await createSubscriber(ctx, { email: 'c@example.com', status: 'unsubscribed' });
}

describe('寄送', () => {
  it('只寄給已訂閱的人，寄完標成 sent', async () => {
    const { ctx, adapter } = await makeContext();
    await seedAudience(ctx);
    const campaign = await createCampaign(ctx, { title: 't', bodyMarkdown: '嗨 {{name}}' });

    const { summary } = await startCampaign(ctx, campaign.id);

    expect(summary).toMatchObject({ total: 2, sent: 2, failed: 0, status: 'sent' });
    expect(adapter.sent.map((m) => m.to).sort()).toEqual(['a@example.com', 'b@example.com']);
    expect((await ctx.store.getCampaign(campaign.id))?.status).toBe('sent');
  });

  it('每封信的內容依收件人個人化', async () => {
    const { ctx, adapter } = await makeContext();
    await seedAudience(ctx);
    const campaign = await createCampaign(ctx, { title: 't', bodyMarkdown: '嗨 {{name}}' });
    await startCampaign(ctx, campaign.id);

    const toA = adapter.sent.find((m) => m.to === 'a@example.com');
    const toB = adapter.sent.find((m) => m.to === 'b@example.com');
    expect(toA?.html).toContain('嗨 阿明');
    expect(toB?.html).toContain('嗨 小美');
    expect(toA?.unsubscribeUrl).toContain('/unsubscribe?token=');
  });

  it('資料夾會縮小寄送範圍', async () => {
    const { ctx, adapter } = await makeContext();
    const vip = await createFolder(ctx, { name: 'VIP' });
    await createSubscriber(ctx, { email: 'a@example.com', folderId: vip.id });
    await createSubscriber(ctx, { email: 'b@example.com' });
    const campaign = await createCampaign(ctx, {
      title: 't',
      bodyMarkdown: '內容',
      audienceFolderId: vip.id,
    });
    await startCampaign(ctx, campaign.id);
    expect(adapter.sent.map((m) => m.to)).toEqual(['a@example.com']);
  });

  it('標籤會縮小寄送範圍', async () => {
    const { ctx, adapter } = await makeContext();
    await seedAudience(ctx);
    const campaign = await createCampaign(ctx, {
      title: 't',
      bodyMarkdown: '內容',
      audienceTags: 'vip',
    });
    await startCampaign(ctx, campaign.id);

    expect(adapter.sent.map((m) => m.to)).toEqual(['a@example.com']);
  });

  it('沒有收件人就不給寄', async () => {
    const { ctx } = await makeContext();
    const campaign = await createCampaign(ctx, { title: 't', bodyMarkdown: '內容' });
    await expect(startCampaign(ctx, campaign.id)).rejects.toThrow('沒有符合條件的收件人');
  });

  it('可重試的失敗會再試，成功後仍算 sent', async () => {
    const { ctx, adapter } = await makeContext();
    await createSubscriber(ctx, { email: 'a@example.com' });
    adapter.behavior = (_message, attempt) =>
      attempt === 1 ? { ok: false, error: '暫時性錯誤', retryable: true } : null;

    const campaign = await createCampaign(ctx, { title: 't', bodyMarkdown: '內容' });
    const { summary } = await startCampaign(ctx, campaign.id);

    expect(summary).toMatchObject({ sent: 1, failed: 0, status: 'sent' });
  });

  it('不可重試的失敗直接標記失敗，不再嘗試', async () => {
    const { ctx, adapter } = await makeContext();
    await createSubscriber(ctx, { email: 'a@example.com' });
    adapter.behavior = () => ({ ok: false, error: '地址無效', retryable: false });

    const campaign = await createCampaign(ctx, { title: 't', bodyMarkdown: '內容' });
    const { summary } = await startCampaign(ctx, campaign.id);

    expect(summary).toMatchObject({ total: 1, sent: 0, failed: 1, status: 'failed' });
    const deliveries = await ctx.store.listDeliveries(campaign.id);
    expect(deliveries[0]?.attempts).toBe(1);
    expect(deliveries[0]?.error).toBe('地址無效');
  });

  it('重試次數用完就收斂成 failed', async () => {
    const { ctx, adapter } = await makeContext({ send: { batchSize: 2, batchDelayMs: 0, maxAttempts: 2 } });
    await createSubscriber(ctx, { email: 'a@example.com' });
    adapter.behavior = () => ({ ok: false, error: '一直失敗', retryable: true });

    const campaign = await createCampaign(ctx, { title: 't', bodyMarkdown: '內容' });
    const { summary } = await startCampaign(ctx, campaign.id);

    expect(summary).toMatchObject({ sent: 0, failed: 1, status: 'failed' });
    expect((await ctx.store.listDeliveries(campaign.id))[0]?.attempts).toBe(2);
  });

  it('中止後未寄出的部分變成 skipped', async () => {
    const { ctx } = await makeContext();
    await seedAudience(ctx);
    const campaign = await createCampaign(ctx, { title: 't', bodyMarkdown: '內容' });
    await ctx.store.updateCampaign(campaign.id, { status: 'scheduled', scheduledAt: new Date().toISOString() });

    const canceled = await cancelSending(ctx, campaign.id);
    expect(canceled.status).toBe('canceled');
  });

  it('測試信不會建立 delivery 紀錄', async () => {
    const { ctx, adapter } = await makeContext();
    const campaign = await createCampaign(ctx, { title: 't', bodyMarkdown: '內容' });
    const result = await sendTestEmail(ctx, campaign.id, 'me@example.com');

    expect(result.ok).toBe(true);
    expect(adapter.sent[0]?.subject).toContain('[測試]');
    expect(await ctx.store.listDeliveries(campaign.id)).toHaveLength(0);
  });
});

describe('排程器', () => {
  it('時間到了才會寄出', async () => {
    const { ctx, adapter } = await makeContext();
    await createSubscriber(ctx, { email: 'a@example.com' });
    const campaign = await createCampaign(ctx, { title: 't', bodyMarkdown: '內容' });
    const scheduler = createScheduler(ctx);

    await ctx.store.updateCampaign(campaign.id, {
      status: 'scheduled',
      scheduledAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await scheduler.tick();
    expect(adapter.sent).toHaveLength(0);

    await ctx.store.updateCampaign(campaign.id, {
      scheduledAt: new Date(Date.now() - 1000).toISOString(),
    });
    await scheduler.tick();
    expect(adapter.sent).toHaveLength(1);
    expect((await ctx.store.getCampaign(campaign.id))?.status).toBe('sent');
  });
});

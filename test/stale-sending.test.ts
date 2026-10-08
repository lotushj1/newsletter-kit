import { describe, expect, it } from 'vitest';
import { nowIso } from '../src/core/ids.js';
import { createCampaign, getCampaign, listCampaigns, STALE_SENDING_MS } from '../src/services/campaigns.js';
import { clearSending, markSending } from '../src/services/send-state.js';
import { startCampaign } from '../src/services/sending.js';
import { createSubscriber } from '../src/services/subscribers.js';
import type { ServiceContext } from '../src/services/context.js';
import { makeContext } from './helpers.js';

/** 重現生產事故：campaign 卡在 sending、一筆 pending delivery、沒有任何進度。 */
async function seedStuckCampaign(ctx: ServiceContext, agoMs: number): Promise<{ campaignId: string; deliveryId: string }> {
  const subscriber = await createSubscriber(ctx, { email: 'reader@example.com', name: '讀者' });
  const campaign = await createCampaign(ctx, { title: '卡住的電子報', bodyMarkdown: '內容' });
  const stuckAt = new Date(Date.now() - agoMs).toISOString();
  await ctx.store.updateCampaign(campaign.id, { status: 'sending', updatedAt: stuckAt });
  const deliveryId = 'dlv_stuck_1';
  await ctx.store.createDeliveries([
    {
      id: deliveryId,
      campaignId: campaign.id,
      subscriberId: subscriber.id,
      email: subscriber.email,
      status: 'pending',
      attempts: 0,
    },
  ]);
  return { campaignId: campaign.id, deliveryId };
}

describe('卡死的「寄送中」自動恢復', () => {
  it('超過時限沒進度的 sending 讀到就標成 failed，後台看得到', async () => {
    const { ctx } = await makeContext();
    const { campaignId } = await seedStuckCampaign(ctx, STALE_SENDING_MS + 60_000);

    const healed = await getCampaign(ctx, campaignId);
    expect(healed.status).toBe('failed');
    expect((await ctx.store.getCampaign(campaignId))?.status).toBe('failed');
  });

  it('清單頁也會就地修復', async () => {
    const { ctx } = await makeContext();
    const { campaignId } = await seedStuckCampaign(ctx, STALE_SENDING_MS + 60_000);

    const { items } = await listCampaigns(ctx, {});
    expect(items.find((c) => c.id === campaignId)?.status).toBe('failed');
  });

  it('還在時限內的 sending 不會被動到，也不能重寄', async () => {
    const { ctx } = await makeContext();
    const { campaignId } = await seedStuckCampaign(ctx, 1000);

    expect((await getCampaign(ctx, campaignId)).status).toBe('sending');
    await expect(startCampaign(ctx, campaignId)).rejects.toThrow('正在寄送中');
  });

  it('這個程序正在寄的不算卡死，就算 updatedAt 很舊', async () => {
    const { ctx } = await makeContext();
    const { campaignId } = await seedStuckCampaign(ctx, STALE_SENDING_MS + 60_000);

    markSending(campaignId);
    try {
      expect((await getCampaign(ctx, campaignId)).status).toBe('sending');
    } finally {
      clearSending(campaignId);
    }
  });

  it('卡死後可以直接重寄：pending 的補寄、冪等鍵沿用 delivery id', async () => {
    const { ctx, adapter } = await makeContext();
    const { campaignId, deliveryId } = await seedStuckCampaign(ctx, STALE_SENDING_MS + 60_000);

    const { summary } = await startCampaign(ctx, campaignId);
    expect(summary).toMatchObject({ total: 1, sent: 1, status: 'sent' });
    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0]?.idempotencyKey).toBe(deliveryId); // 同一筆 delivery，不會重複寄
    expect((await ctx.store.getCampaign(campaignId))?.status).toBe('sent');
  });

  it('寄送迴圈每批都更新 updatedAt 當心跳', async () => {
    const { ctx } = await makeContext();
    await createSubscriber(ctx, { email: 'a@example.com' });
    const campaign = await createCampaign(ctx, { title: 't', bodyMarkdown: '內容' });
    const before = nowIso();
    await startCampaign(ctx, campaign.id);
    const after = await ctx.store.getCampaign(campaign.id);
    expect(after?.updatedAt && after.updatedAt >= before).toBe(true);
  });
});

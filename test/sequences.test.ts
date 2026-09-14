import { describe, expect, it } from 'vitest';
import { enrollSubscriber } from '../src/services/enroll.js';
import { createCampaign } from '../src/services/campaigns.js';
import { createFolder } from '../src/services/folders.js';
import { createSequence, processDueEnrollments, updateSequence } from '../src/services/sequences.js';
import { createSubscriber, unsubscribeByEmail, updateSubscriber } from '../src/services/subscribers.js';
import { makeContext } from './helpers.js';

describe('序列自動化', () => {
  it('新訂閱會入隊，到期就寄出範本信', async () => {
    const { ctx, adapter } = await makeContext();
    const campaign = await createCampaign(ctx, {
      title: '歡迎',
      bodyHtml: '<p>嗨 {{name}}</p>',
    });
    await createSequence(ctx, {
      name: '歡迎序列',
      trigger: 'subscribe',
      steps: [{ delayDays: 0, campaignId: campaign.id }],
    });
    const subscriber = await createSubscriber(ctx, { email: 'a@example.com', name: '阿明' });
    await enrollSubscriber(ctx, subscriber, { type: 'subscribe' });

    expect(await processDueEnrollments(ctx)).toBe(1);
    expect(adapter.sent.some((m) => m.to === 'a@example.com' && m.html.includes('嗨 阿明'))).toBe(true);
    expect((await ctx.store.getCampaign(campaign.id))?.status).toBe('draft');
    expect((await ctx.store.getEnrollment((await ctx.store.listSequences())[0]!.id, subscriber.id))?.status).toBe(
      'completed',
    );
  });

  it('帶標籤匯入才會進對應序列', async () => {
    const { ctx } = await makeContext();
    const campaign = await createCampaign(ctx, { title: '設計', bodyHtml: '<p>設計</p>' });
    await createSequence(ctx, {
      name: '設計序列',
      trigger: 'tag',
      triggerValue: 'design',
      steps: [{ delayDays: 0, campaignId: campaign.id }],
    });
    const other = await createSubscriber(ctx, { email: 'a@example.com', tags: 'marketing' });
    expect(await enrollSubscriber(ctx, other, { type: 'tag', tags: ['marketing'] })).toBe(0);
    const designer = await createSubscriber(ctx, { email: 'b@example.com', tags: 'design' });
    const sequence = (await ctx.store.listSequences())[0]!;
    expect(await ctx.store.getEnrollment(sequence.id, designer.id)).toBeTruthy();
    expect(await enrollSubscriber(ctx, designer, { type: 'tag', tags: ['design'] })).toBe(0);
  });

  it('放進資料夾會進對應序列', async () => {
    const { ctx } = await makeContext();
    const campaign = await createCampaign(ctx, { title: '資料夾信', bodyHtml: '<p>資料夾</p>' });
    const folder = await createFolder(ctx, { name: '新手' });
    const sequence = await createSequence(ctx, {
      name: '資料夾序列',
      trigger: 'folder',
      triggerValue: folder.id,
      steps: [{ delayDays: 0, campaignId: campaign.id }],
    });
    const inside = await createSubscriber(ctx, { email: 'c@example.com', folderId: folder.id });
    expect(await ctx.store.getEnrollment(sequence.id, inside.id)).toBeTruthy();

    const later = await createSubscriber(ctx, { email: 'd@example.com' });
    expect(await ctx.store.getEnrollment(sequence.id, later.id)).toBeFalsy();
    await updateSubscriber(ctx, later.id, { folderId: folder.id });
    expect(await ctx.store.getEnrollment(sequence.id, later.id)).toBeTruthy();
  });

  it('沒選電子報不能啟用', async () => {
    const { ctx } = await makeContext();
    const sequence = await createSequence(ctx, {
      name: '草稿',
      trigger: 'subscribe',
      enabled: false,
      steps: [{ delayDays: 0, campaignId: '' }],
    });
    await expect(updateSequence(ctx, sequence.id, { enabled: true })).rejects.toThrow('啟用前請先選好要寄的電子報');
  });

  it('有一步沒選電子報也不能啟用', async () => {
    const { ctx } = await makeContext();
    const campaign = await createCampaign(ctx, { title: '第一封', bodyHtml: '<p>一</p>' });
    const sequence = await createSequence(ctx, {
      name: '兩步',
      trigger: 'subscribe',
      enabled: false,
      steps: [
        { delayDays: 0, campaignId: campaign.id },
        { delayDays: 2, campaignId: '' },
      ],
    });
    await expect(updateSequence(ctx, sequence.id, { enabled: true })).rejects.toThrow('啟用前請先選好要寄的電子報');
  });

  it('退訂會進對應序列', async () => {
    const { ctx } = await makeContext();
    const campaign = await createCampaign(ctx, { title: '退訂信', bodyHtml: '<p>掰</p>' });
    const sequence = await createSequence(ctx, {
      name: '退訂序列',
      trigger: 'unsubscribe',
      steps: [{ delayDays: 0, campaignId: campaign.id }],
    });
    const person = await createSubscriber(ctx, { email: 'e@example.com' });
    expect(await ctx.store.getEnrollment(sequence.id, person.id)).toBeFalsy();
    await unsubscribeByEmail(ctx, 'e@example.com');
    expect(await ctx.store.getEnrollment(sequence.id, person.id)).toBeTruthy();
  });

  it('開信與點擊會進對應序列', async () => {
    const { ctx } = await makeContext();
    const watched = await createCampaign(ctx, { title: '被看的信', bodyHtml: '<p>看</p>' });
    const follow = await createCampaign(ctx, { title: '跟進', bodyHtml: '<p>跟</p>' });
    const openSeq = await createSequence(ctx, {
      name: '開信序列',
      trigger: 'open',
      triggerValue: watched.id,
      steps: [{ delayDays: 0, campaignId: follow.id }],
    });
    const clickSeq = await createSequence(ctx, {
      name: '點擊序列',
      trigger: 'click',
      steps: [{ delayDays: 0, campaignId: follow.id }],
    });
    const person = await createSubscriber(ctx, { email: 'f@example.com' });
    expect(await enrollSubscriber(ctx, person, { type: 'open', campaignId: watched.id })).toBe(1);
    expect(await ctx.store.getEnrollment(openSeq.id, person.id)).toBeTruthy();
    expect(await enrollSubscriber(ctx, person, { type: 'click', campaignId: watched.id })).toBe(1);
    expect(await ctx.store.getEnrollment(clickSeq.id, person.id)).toBeTruthy();
  });
});

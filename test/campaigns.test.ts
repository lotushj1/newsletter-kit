import { describe, expect, it } from 'vitest';
import {
  cancelSchedule,
  createCampaign,
  previewCampaign,
  renderCampaign,
  renderPublicCampaign,
  scheduleCampaign,
  updateCampaign,
} from '../src/services/campaigns.js';
import { createSubscriber } from '../src/services/subscribers.js';
import { makeContext } from './helpers.js';

const later = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

describe('電子報內容', () => {
  it('新建時預設是草稿，主旨沒填就沿用標題', async () => {
    const { ctx } = await makeContext();
    const campaign = await createCampaign(ctx, { title: '九月號' });

    expect(campaign.status).toBe('draft');
    expect(campaign.subject).toBe('九月號');
    expect(campaign.slug).toBe('九月號');
  });

  it('渲染時會把 Markdown 轉 HTML 並替換變數', async () => {
    const { ctx } = await makeContext();
    const campaign = await createCampaign(ctx, {
      title: 't',
      subject: '嗨 {{name}}',
      bodyMarkdown: '## 標題\n\n你好 {{name}}，[退訂]({{unsubscribe_url}})',
    });
    const rendered = renderCampaign(ctx, campaign, { email: 'a@example.com', name: '阿明' });

    expect(rendered.subject).toBe('嗨 阿明');
    expect(rendered.html).toContain('<h2>標題</h2>');
    expect(rendered.html).toContain('你好 阿明');
    expect(rendered.html).toContain('/unsubscribe?token=');
    expect(rendered.text).toContain('你好 阿明');
  });

  it('沒有名字時用預設稱呼，不會把 {{name}} 寄出去', async () => {
    const { ctx } = await makeContext();
    const campaign = await createCampaign(ctx, { title: 't', bodyMarkdown: '嗨 {{name}}' });
    const rendered = renderCampaign(ctx, campaign, { email: 'a@example.com', name: undefined });

    expect(rendered.html).toContain('嗨 朋友');
    expect(rendered.html).not.toContain('{{');
  });

  it('變數值會做 HTML escape', async () => {
    const { ctx } = await makeContext();
    const campaign = await createCampaign(ctx, { title: 't', bodyMarkdown: '{{name}}' });
    const rendered = renderCampaign(ctx, campaign, {
      email: 'a@example.com',
      name: '<script>alert(1)</script>',
    });

    expect(rendered.html).not.toContain('<script>alert(1)</script>');
    expect(rendered.html).toContain('&lt;script&gt;');
  });

  it('預覽會回報目前符合條件的收件人數', async () => {
    const { ctx } = await makeContext();
    await createSubscriber(ctx, { email: 'a@example.com', tags: 'vip' });
    await createSubscriber(ctx, { email: 'b@example.com' });
    const campaign = await createCampaign(ctx, { title: 't', audienceTags: 'vip' });

    expect((await previewCampaign(ctx, campaign.id)).audienceCount).toBe(1);
  });
});

describe('排程', () => {
  it('可以排到未來時間', async () => {
    const { ctx } = await makeContext();
    const campaign = await createCampaign(ctx, { title: 't', bodyMarkdown: '內容' });
    const scheduled = await scheduleCampaign(ctx, campaign.id, later(30));

    expect(scheduled.status).toBe('scheduled');
    expect(await ctx.store.findDueCampaigns(new Date().toISOString())).toHaveLength(0);
    expect(await ctx.store.findDueCampaigns(later(60))).toHaveLength(1);
  });

  it('不能排到過去', async () => {
    const { ctx } = await makeContext();
    const campaign = await createCampaign(ctx, { title: 't', bodyMarkdown: '內容' });
    await expect(scheduleCampaign(ctx, campaign.id, later(-30))).rejects.toThrow('不能是過去');
  });

  it('內文空白不給排程', async () => {
    const { ctx } = await makeContext();
    const campaign = await createCampaign(ctx, { title: 't' });
    await expect(scheduleCampaign(ctx, campaign.id, later(30))).rejects.toThrow('內文還是空的');
  });

  it('取消排程會回到草稿', async () => {
    const { ctx } = await makeContext();
    const campaign = await createCampaign(ctx, { title: 't', bodyMarkdown: '內容' });
    await scheduleCampaign(ctx, campaign.id, later(30));
    const back = await cancelSchedule(ctx, campaign.id);

    expect(back.status).toBe('draft');
    expect(back.scheduledAt).toBeNull();
  });

  it('已寄出的電子報不能再編輯', async () => {
    const { ctx } = await makeContext();
    const campaign = await createCampaign(ctx, { title: 't', bodyMarkdown: '內容' });
    await ctx.store.updateCampaign(campaign.id, { status: 'sent' });

    await expect(updateCampaign(ctx, campaign.id, { title: '改標題' })).rejects.toThrow('不能再編輯');
  });
});

describe('公開封存', () => {
  it('只吐已寄出的電子報', async () => {
    const { ctx } = await makeContext();
    const campaign = await createCampaign(ctx, { title: 't', slug: 'issue-1', bodyMarkdown: '哈囉' });

    expect(await renderPublicCampaign(ctx, 'issue-1')).toBeNull();

    await ctx.store.updateCampaign(campaign.id, { status: 'sent' });
    const published = await renderPublicCampaign(ctx, 'issue-1');
    expect(published?.html).toContain('哈囉');
  });
});

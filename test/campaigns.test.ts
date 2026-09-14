import { describe, expect, it } from 'vitest';
import {
  cancelSchedule,
  createCampaign,
  listCampaigns,
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
  it('同一標題再新增時會自動換 slug', async () => {
    const { ctx } = await makeContext();
    const first = await createCampaign(ctx, { title: '未命名電子報' });
    const second = await createCampaign(ctx, { title: '未命名電子報' });

    expect(first.slug).toBe('未命名電子報');
    expect(second.slug).toBe('未命名電子報-2');
    expect(second.id).not.toBe(first.id);
  });

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
    const rendered = await renderCampaign(ctx, campaign, { email: 'a@example.com', name: '阿明' });

    expect(rendered.subject).toBe('嗨 阿明');
    expect(rendered.html).toContain('<h2>標題</h2>');
    expect(rendered.html).toContain('你好 阿明');
    expect(rendered.html).toContain('/unsubscribe?token=');
    expect(rendered.text).toContain('你好 阿明');
  });

  it('沒有名字時用預設稱呼，不會把 {{name}} 寄出去', async () => {
    const { ctx } = await makeContext();
    const campaign = await createCampaign(ctx, { title: 't', bodyMarkdown: '嗨 {{name}}' });
    const rendered = await renderCampaign(ctx, campaign, { email: 'a@example.com', name: undefined });

    expect(rendered.html).toContain('嗨 朋友');
    expect(rendered.html).not.toContain('{{');
  });

  it('按鈕與影音在寄出時會轉成信箱吃得下的連結', async () => {
    const { ctx } = await makeContext();
    const campaign = await createCampaign(ctx, {
      title: 't',
      bodyHtml:
        '<div data-email-btn="1" data-href="https://example.com/join">立刻訂閱</div><figure data-email-audio data-src="https://example.com/a.mp3"></figure>',
    });
    const rendered = await renderCampaign(ctx, campaign, { email: 'a@example.com', name: '阿明' });
    expect(rendered.html).toContain('立刻訂閱');
    expect(rendered.html).toContain('https://example.com/join');
    expect(rendered.html).toContain('播放音訊');
    expect(rendered.html).toContain('background:#1c1917');
  });

  it('按鈕顏色、外框與圓角會帶進寄出 HTML', async () => {
    const { ctx } = await makeContext();
    const campaign = await createCampaign(ctx, {
      title: 't',
      bodyHtml:
        '<div data-email-btn="1" data-href="https://example.com/join" data-bg="#fff7ed" data-border="3" data-border-color="#c2410c" data-radius="24">立刻訂閱</div>',
    });
    const rendered = await renderCampaign(ctx, campaign, { email: 'a@example.com', name: '阿明' });
    expect(rendered.html).toContain('background:#fff7ed');
    expect(rendered.html).toContain('background:#c2410c');
    expect(rendered.html).toContain('padding:3px');
    expect(rendered.html).toContain('border-radius:24px');
    expect(rendered.html).toContain('border-radius:27px');
    expect(rendered.html).toContain('color:#1c1917');
  });

  it('變數值會做 HTML escape', async () => {
    const { ctx } = await makeContext();
    const campaign = await createCampaign(ctx, { title: 't', bodyMarkdown: '{{name}}' });
    const rendered = await renderCampaign(ctx, campaign, {
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
  it('bodyHtml 優先於 Markdown', async () => {
    const { ctx } = await makeContext();
    const campaign = await createCampaign(ctx, {
      title: 't',
      bodyMarkdown: '舊 markdown',
      bodyHtml: '<p>新 HTML {{name}}</p>',
    });
    const rendered = await renderCampaign(ctx, campaign, { email: 'a@example.com', name: '阿明' });
    expect(rendered.html).toContain('新 HTML 阿明');
    expect(rendered.html).not.toContain('舊 markdown');
  });

  it('列表可用搜尋與時間篩選', async () => {
    const { ctx } = await makeContext();
    await createCampaign(ctx, { title: '九月號週報', subject: '秋天' });
    await createCampaign(ctx, { title: '產品更新' });
    const found = await listCampaigns(ctx, { search: '週報' });
    expect(found.total).toBe(1);
    expect(found.items[0]?.title).toBe('九月號週報');
  });

  it('只吐已寄出的電子報', async () => {
    const { ctx } = await makeContext();
    const campaign = await createCampaign(ctx, { title: 't', slug: 'issue-1', bodyMarkdown: '哈囉' });

    expect(await renderPublicCampaign(ctx, 'issue-1')).toBeNull();

    await ctx.store.updateCampaign(campaign.id, { status: 'sent' });
    const published = await renderPublicCampaign(ctx, 'issue-1');
    expect(published?.html).toContain('哈囉');
  });
});

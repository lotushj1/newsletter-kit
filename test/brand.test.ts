import { describe, expect, it } from 'vitest';
import { createCampaign, renderCampaign } from '../src/services/campaigns.js';
import { buildBrandSignatureHtml } from '../src/core/brand-signature.js';
import { getBrand, updateBrand } from '../src/services/brand.js';
import {
  copyCampaignStarter,
  createCampaignStarter,
  createCampaignStarterFromCampaign,
  deleteCampaignStarter,
  listCampaignStarters,
  updateCampaignStarter,
} from '../src/services/starters.js';
import { makeContext } from './helpers.js';

describe('品牌與自訂模板', () => {
  it('會用顯示名稱與網站組成簽名', () => {
    expect(buildBrandSignatureHtml('凱文', 'https://example.com')).toBe(
      '<p>凱文</p><p><a href="https://example.com">example.com</a></p>',
    );
    expect(buildBrandSignatureHtml('', '')).toBe('');
  });

  it('可以儲存顯示名稱、網站與簽名', async () => {
    const { ctx } = await makeContext();
    expect(await getBrand(ctx)).toEqual({ writerName: '', websiteUrl: '', signatureHtml: '' });
    const saved = await updateBrand(ctx, {
      writerName: '凱文',
      websiteUrl: 'https://example.com',
      signatureHtml: '<p>{{writer}}</p><p><a href="{{website}}">網站</a></p>',
    });
    expect(saved.writerName).toBe('凱文');
    expect(await getBrand(ctx)).toEqual(saved);
  });

  it('寄出時會帶入簽名 HTML，不會 escape', async () => {
    const { ctx } = await makeContext();
    await updateBrand(ctx, {
      writerName: '凱文',
      websiteUrl: 'https://example.com',
      signatureHtml: '<p><strong>{{writer}}</strong></p>',
    });
    const campaign = await createCampaign(ctx, {
      title: 't',
      bodyHtml: '<p>嗨 {{name}}</p>{{signature}}',
    });
    const rendered = await renderCampaign(ctx, campaign, { email: 'a@example.com', name: '阿明' });
    expect(rendered.html).toContain('嗨 阿明');
    expect(rendered.html).toContain('<strong>凱文</strong>');
    expect(rendered.html).not.toContain('{{signature}}');
  });

  it('沒有自訂簽名時，寄出會用名稱與網站組成', async () => {
    const { ctx } = await makeContext();
    await updateBrand(ctx, { writerName: '凱文', websiteUrl: 'example.com' });
    const campaign = await createCampaign(ctx, {
      title: 't',
      bodyHtml: '<p>正文</p>{{signature}}',
    });
    const rendered = await renderCampaign(ctx, campaign, { email: 'a@example.com', name: '阿明' });
    expect(rendered.html).toContain('凱文');
    expect(rendered.html).toContain('href="https://example.com"');
    expect(rendered.html).not.toContain('{{signature}}');
  });

  it('列出內建模板，並可新增、複製、刪除自訂模板', async () => {
    const { ctx } = await makeContext();
    const listed = await listCampaignStarters(ctx);
    expect(listed.some((item) => item.id === 'weekly' && item.builtin)).toBe(true);

    const created = await createCampaignStarter(ctx, {
      name: '月底回顧',
      description: '每個月寫一次',
      title: '這個月想留下的事',
      preheader: '慢慢看',
      bodyHtml: '<p>嗨 {{name}}，</p>{{signature}}',
    });
    expect(created.builtin).toBe(false);
    expect(created.id.startsWith('cst_')).toBe(true);
    const listedAfterCreate = await listCampaignStarters(ctx);
    expect(listedAfterCreate[0]?.id).toBe(created.id);

    const copied = await copyCampaignStarter(ctx, 'welcome');
    expect(copied.builtin).toBe(false);
    expect(copied.name).toContain('我的');
    expect(copied.bodyHtml).toContain('{{signature}}');

    await expect(updateCampaignStarter(ctx, 'weekly', { name: '改名' })).rejects.toThrow('內建');
    await expect(deleteCampaignStarter(ctx, 'weekly')).rejects.toThrow('內建');

    await deleteCampaignStarter(ctx, created.id);
    const after = await listCampaignStarters(ctx);
    expect(after.some((item) => item.id === created.id)).toBe(false);
  });

  it('可以把已寄出的電子報存成模板，原信件不會被改', async () => {
    const { ctx } = await makeContext();
    const campaign = await createCampaign(ctx, {
      title: '八月號',
      preheader: '慢慢看',
      bodyHtml: '<p>嗨 {{name}}，這期想講一件事。</p>{{signature}}',
    });
    await ctx.store.updateCampaign(campaign.id, { status: 'sent', sentAt: new Date().toISOString() });

    const starter = await createCampaignStarterFromCampaign(ctx, campaign.id);
    expect(starter.builtin).toBe(false);
    expect(starter.name).toBe('八月號');
    expect(starter.title).toBe('八月號');
    expect(starter.preheader).toBe('慢慢看');
    expect(starter.bodyHtml).toContain('這期想講一件事');
    expect(starter.description).toContain('八月號');

    const again = await createCampaignStarterFromCampaign(ctx, campaign.id);
    expect(again.name).toBe('八月號（模板）');

    const original = await ctx.store.getCampaign(campaign.id);
    expect(original?.status).toBe('sent');
    expect(original?.title).toBe('八月號');
    expect(original?.bodyHtml).toContain('這期想講一件事');
  });

  it('空白電子報不能存成模板', async () => {
    const { ctx } = await makeContext();
    const empty = await createCampaign(ctx, { title: '還沒寫' });
    await expect(createCampaignStarterFromCampaign(ctx, empty.id)).rejects.toThrow('沒有內容');
  });
});

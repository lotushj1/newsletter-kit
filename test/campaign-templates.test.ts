import { describe, expect, it } from 'vitest';
import { BUILTIN_CAMPAIGN_STARTERS } from '../src/core/campaign-starters';
import { renderPreviewEmail } from '../src/core/preview-email.js';
import { getBrand, updateBrand } from '../src/services/brand.js';
import { createCampaign, previewCampaign } from '../src/services/campaigns.js';
import { makeContext } from './helpers.js';

function sameLetter(html: string): string {
  return html.replace(/href="[^"]*unsubscribe[^"]*"/g, 'href="#"');
}

describe('電子報建立模板', () => {
  it('每種模板都有名稱與可編輯的內文', () => {
    const ids = BUILTIN_CAMPAIGN_STARTERS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const item of BUILTIN_CAMPAIGN_STARTERS) {
      expect(item.name).toBeTruthy();
      expect(item.bodyHtml).toContain('{{name}}');
      expect(item.bodyHtml).toContain('{{signature}}');
      expect(item.bodyHtml).toMatch(/<p>|<h2>|<ul>/);
      expect(item.bodyHtml).toContain('data-email-hero');
      expect(item.bodyHtml).toContain('data-email-image-slot');
      expect(item.bodyHtml).not.toMatch(/新功能|產品更新|changelog|SaaS/i);
    }
    expect(BUILTIN_CAMPAIGN_STARTERS.some((item) => item.id === 'work')).toBe(true);
    expect(BUILTIN_CAMPAIGN_STARTERS.some((item) => item.name === '產品更新')).toBe(false);
  });

  it('模板縮圖與後台預覽是同一封信', async () => {
    const { ctx } = await makeContext();
    await updateBrand(ctx, { writerName: '凱文', websiteUrl: 'https://example.com' });
    const starter = BUILTIN_CAMPAIGN_STARTERS[0]!;
    const campaign = await createCampaign(ctx, {
      title: starter.title,
      subject: starter.title,
      preheader: starter.preheader,
      bodyHtml: starter.bodyHtml,
    });
    const actual = await previewCampaign(ctx, campaign.id);
    const thumb = renderPreviewEmail({
      bodyHtml: starter.bodyHtml,
      subject: campaign.subject,
      preheader: starter.preheader,
      siteName: ctx.config.siteName,
      publicBaseUrl: ctx.config.publicBaseUrl,
      brand: await getBrand(ctx),
    });
    expect(sameLetter(thumb.html)).toBe(sameLetter(actual.html));
    expect(thumb.html).toContain('預覽收件人');
    expect(thumb.html).toContain('凱文');
    expect(thumb.html).toContain('max-width:600px');
    expect(thumb.html).not.toContain('{{signature}}');
    expect(thumb.html).not.toContain('data-email-image-slot');
  });
});

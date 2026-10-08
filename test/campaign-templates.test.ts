import { describe, expect, it } from 'vitest';
import { BUILTIN_CAMPAIGN_STARTERS, EMPTY_STARTER_BODY } from '../src/core/campaign-starters';
import { EMAIL_CARD_THUMB } from '../src/core/email-blocks.js';
import { EMAIL_COVER_STYLE, EMAIL_IMAGE_STYLE, isFullWidthSlotLabel } from '../src/core/email-image.js';
import { EMAIL_TONES } from '../src/core/email-theme.js';
import { renderPreviewEmail } from '../src/core/preview-email.js';
import { renderEmailLayout } from '../src/core/render.js';
import { confirmEmailContentHtml } from '../src/core/system-emails.js';
import { getBrand, updateBrand } from '../src/services/brand.js';
import { createCampaign, previewCampaign } from '../src/services/campaigns.js';
import { startCampaign } from '../src/services/sending.js';
import { createSubscriber } from '../src/services/subscribers.js';
import { EMPTY_BRAND } from '../src/store/types.js';
import { makeContext } from './helpers.js';

const BLEED_ROW = 'padding:0;font-size:0;line-height:0;';

function sameLetter(html: string): string {
  return html.replace(/href="[^"]*unsubscribe[^"]*"/g, 'href="#"');
}

function starter(id: string) {
  const found = BUILTIN_CAMPAIGN_STARTERS.find((item) => item.id === id);
  if (!found) throw new Error(`沒有 ${id} 模板`);
  return found;
}

function preview(bodyHtml: string, imageSlots?: 'placeholder'): string {
  return renderPreviewEmail({ bodyHtml, siteName: '測試電子報', brand: EMPTY_BRAND, imageSlots }).html;
}

/** 每種模板的骨架：用到哪些區塊、圖片放在哪。 */
function skeleton(html: string): string {
  const blocks = [...html.matchAll(/data-email-style="([a-z]+)"/g)].map((match) => match[1]);
  const lead = /^\s*<figure data-email-image-slot/.test(html) ? 'cover' : 'text';
  return `${lead}:${blocks.join(',')}`;
}

describe('電子報建立模板', () => {
  it('五種內建模板各有名稱、可編輯內文與簽名', () => {
    const ids = BUILTIN_CAMPAIGN_STARTERS.map((item) => item.id);
    expect(ids).toEqual(['weekly', 'welcome', 'announcement', 'work', 'letter']);
    for (const item of BUILTIN_CAMPAIGN_STARTERS) {
      expect(item.name).toBeTruthy();
      expect(item.description).toBeTruthy();
      expect(item.bodyHtml).toContain('{{name}}');
      expect(item.bodyHtml.endsWith('{{signature}}')).toBe(true);
      expect(item.bodyHtml).not.toMatch(/newsletter/i);
      expect(item.bodyHtml).not.toMatch(/新功能|產品更新|changelog|SaaS/i);
    }
  });

  it('模板不外連任何圖片，圖片位置一律用空位標出建議尺寸', () => {
    for (const body of [...BUILTIN_CAMPAIGN_STARTERS.map((item) => item.bodyHtml), EMPTY_STARTER_BODY]) {
      expect(body).not.toMatch(/<img\b/i);
      expect(body).not.toMatch(/unsplash|picsum|images\./i);
      for (const match of body.matchAll(/<figure data-email-image-slot="1" data-label="([^"]*)"/g)) {
        expect(match[1]).toMatch(/｜建議 \d+×\d+$/);
      }
    }
  });

  it('每種模板的版面骨架都不一樣', () => {
    const shapes = BUILTIN_CAMPAIGN_STARTERS.map((item) => skeleton(item.bodyHtml));
    expect(new Set(shapes).size).toBe(shapes.length);

    const weekly = starter('weekly').bodyHtml;
    expect(weekly.match(/data-email-style="kicker"/g)).toHaveLength(4);
    expect(weekly).toMatch(/01　觀察[\s\S]*02　推薦[\s\S]*03　近況/);
    expect(weekly).toContain('data-email-style="card"');

    const welcome = starter('welcome').bodyHtml;
    expect(welcome).toContain('data-email-style="steps"');
    expect(welcome).toMatch(/^<figure data-email-image-slot="1" data-label="封面/);

    const invite = starter('announcement').bodyHtml;
    expect(invite).toMatch(/^<figure data-email-image-slot="1" data-label="封面：活動主視覺/);
    expect(invite).toContain('data-email-style="panel"');
    for (const key of ['日期', '時間', '地點', '對象']) expect(invite).toContain(`<strong>${key}</strong>`);
    expect(invite.match(/data-email-btn/g)).toHaveLength(1);

    const work = starter('work').bodyHtml;
    expect(work.indexOf('<h1>作品名稱</h1>')).toBeLessThan(work.indexOf('data-email-image-slot'));
    expect(work).toContain('data-email-style="meta"');
    expect(work).toContain('打開作品');

    const letter = starter('letter').bodyHtml;
    expect(letter).not.toContain('data-email-image-slot');
    expect(letter).not.toContain('data-email-btn');
    expect(letter).toContain('data-email-style="pull"');
    expect(letter).toContain('data-email-style="ornament"');

    // 每種模板一個點綴色。
    const tones = BUILTIN_CAMPAIGN_STARTERS.map((item) => /data-email-tone="([a-z]+)"/.exec(item.bodyHtml)?.[1]);
    expect(new Set(tones).size).toBe(5);
  });

  it('模板縮圖與後台預覽是同一封信', async () => {
    const { ctx } = await makeContext();
    await updateBrand(ctx, { writerName: '凱文', websiteUrl: 'https://example.com' });
    const item = BUILTIN_CAMPAIGN_STARTERS[0]!;
    const campaign = await createCampaign(ctx, {
      title: item.title,
      subject: item.title,
      preheader: item.preheader,
      bodyHtml: item.bodyHtml,
    });
    const actual = await previewCampaign(ctx, campaign.id);
    const thumb = renderPreviewEmail({
      bodyHtml: item.bodyHtml,
      subject: campaign.subject,
      preheader: item.preheader,
      siteName: ctx.config.siteName,
      publicBaseUrl: ctx.config.publicBaseUrl,
      brand: await getBrand(ctx),
    });
    expect(sameLetter(thumb.html)).toBe(sameLetter(actual.html));
    expect(thumb.html).toContain('預覽收件人');
    expect(thumb.html).toContain('凱文');
    expect(thumb.html).toContain('max-width:600px');
    expect(thumb.html).toContain('padding:24px;');
    expect(thumb.html.indexOf(ctx.config.siteName)).toBeLessThan(thumb.html.indexOf('class="nk-card"'));
    expect(thumb.html).not.toContain('{{signature}}');
    expect(thumb.html).not.toContain('data-email-image-slot');
    expect(thumb.html).not.toContain('data-email-placeholder');
  });

  it('寄出的信把還沒放圖的空位拿掉，不會寄出占位圖', async () => {
    const { ctx, adapter } = await makeContext();
    await createSubscriber(ctx, { email: 'a@example.com', name: '阿明' });
    for (const item of BUILTIN_CAMPAIGN_STARTERS) {
      const campaign = await createCampaign(ctx, { title: item.title, bodyHtml: item.bodyHtml });
      await startCampaign(ctx, campaign.id);
    }
    expect(adapter.sent).toHaveLength(BUILTIN_CAMPAIGN_STARTERS.length);
    for (const mail of adapter.sent) {
      expect(mail.html).not.toContain('data-email-image-slot');
      expect(mail.html).not.toContain('data-email-placeholder');
      expect(mail.html).not.toContain('data:image/svg');
      expect(mail.html).not.toContain('建議 1200');
      expect(mail.text).not.toContain('建議 1200');
    }
  });

  it('模板縮圖把空位畫成占位圖：封面貼邊、卡片裡當縮圖、其餘對齊內文欄', () => {
    const invite = preview(starter('announcement').bodyHtml, 'placeholder');
    expect(invite).toContain('data-email-placeholder="1"');
    expect(invite.indexOf(BLEED_ROW)).toBeLessThan(invite.indexOf('class="nk-pad"'));
    expect(invite).toContain(EMAIL_COVER_STYLE);
    const cover = /<img[^>]*src="(data:image\/svg\+xml;charset=utf-8,[^"]+)"/.exec(invite)?.[1] ?? '';
    expect(decodeURIComponent(cover)).toContain('建議 1200×630');

    const weekly = preview(starter('weekly').bodyHtml, 'placeholder');
    expect(weekly).toContain(`width="${EMAIL_CARD_THUMB}"`);
    expect(weekly).toContain(EMAIL_IMAGE_STYLE);
    expect(weekly).not.toContain(BLEED_ROW);

    const work = preview(starter('work').bodyHtml, 'placeholder');
    // 作品圖在標題之後，滿版貼邊但不當封面。
    expect(work.indexOf('class="nk-pad"')).toBeLessThan(work.indexOf(BLEED_ROW));
  });

  it('模板區塊在信裡變成 table 與 inline style，不留下編輯器屬性', () => {
    for (const item of BUILTIN_CAMPAIGN_STARTERS) {
      const html = preview(item.bodyHtml, 'placeholder');
      expect(html).not.toContain('data-email-style');
      expect(html).not.toContain('<blockquote');
      expect(html).not.toMatch(/<ol\b[^>]*data-email/);
    }
    const invite = preview(starter('announcement').bodyHtml);
    expect(invite).toMatch(/<table class="nk-panel nk-tone-vermilion" role="presentation"[^>]*style="[^"]*background:#faefe9/);
    expect(invite).toMatch(/<td class="nk-key"[^>]*style="[^"]*color:#ad4329;[^"]*">日期<\/td>/);
    expect(invite).not.toMatch(/<td[^>]*>　/);

    const welcome = preview(starter('welcome').bodyHtml);
    expect(welcome).toMatch(/<table class="nk-steps nk-tone-clay"/);
    expect(welcome.match(/class="nk-step"/g)).toHaveLength(3);

    const weekly = preview(starter('weekly').bodyHtml);
    expect(weekly).toMatch(/<table class="nk-box nk-tone-sage"[^>]*border-top:3px solid #3f6b58/);
    // 卡片的縮圖空位寄出時拿掉，只留文字欄。
    expect(weekly).not.toContain('class="nk-box-thumb"');
    // 標籤底下的標題不留上外距。
    expect(weekly).toMatch(/01　觀察<\/p><h2 style="margin:0 /);

    const letter = preview(starter('letter').bodyHtml);
    expect(letter).toMatch(/<table class="nk-pull nk-tone-ink"/);
    expect(letter).toContain('class="nk-orn nk-tone-ink"');
    expect(letter).not.toContain('<hr');

    const work = preview(starter('work').bodyHtml);
    expect(work).toMatch(/<p class="nk-meta nk-tone-indigo" style="[^"]*border-top:1px solid #d4dbe7/);
    expect(work).toContain('background:#34507a');

    // 深色模式每個點綴色都有替換值。
    for (const tone of Object.keys(EMAIL_TONES)) expect(work).toContain(`.nk-tone-${tone}.nk-kicker`);
  });

  it('換成真圖後，滿版／一般寬度切換照舊；卡片裡的圖變縮圖', () => {
    const src = 'https://cdn.example.com/work.jpg';
    const slot = /<figure data-email-image-slot="1" data-label="([^"]*)">[\s\S]*?<\/figure>/;
    const work = starter('work').bodyHtml;
    expect(isFullWidthSlotLabel(slot.exec(work)![1]!)).toBe(true);

    const full = preview(work.replace(slot, `<img src="${src}" alt="" data-email-hero="1" data-email-fullwidth="1">`));
    expect(full).toMatch(new RegExp(`${BLEED_ROW}"><img[^>]*src="${src}"`));

    const normal = preview(work.replace(slot, `<img src="${src}" alt="" data-email-fullwidth="0">`));
    expect(normal).not.toContain(BLEED_ROW);
    expect(normal).toMatch(new RegExp(`<img[^>]*src="${src}"[^>]*style="${EMAIL_IMAGE_STYLE}`));

    const weekly = starter('weekly').bodyHtml.replace(
      /(<blockquote data-email-style="card"[^>]*>)<figure[\s\S]*?<\/figure>/,
      `$1<img src="${src}" alt="" data-email-fullwidth="0">`,
    );
    const card = preview(weekly);
    expect(card).toContain('class="nk-box-thumb"');
    expect(card).toMatch(new RegExp(`<img width="${EMAIL_CARD_THUMB}"[^>]*src="${src}"|<img[^>]*src="${src}"[^>]*width="${EMAIL_CARD_THUMB}"`));
  });

  it('訂閱確認信：一個確認按鈕，按鈕失效時有網址可貼', () => {
    const link = 'https://news.example.com/confirm?token=a&b=1';
    const html = renderEmailLayout({
      subject: '確認訂閱',
      contentHtml: confirmEmailContentHtml('凱文設計 <Kevin>', link),
      siteName: '凱文設計',
    });
    expect(html.match(/class="nk-btn"/g)).toHaveLength(1);
    expect(html).toContain('href="https://news.example.com/confirm?token=a&amp;b=1"');
    expect(html).not.toContain('&amp;amp;');
    expect(html).toContain('凱文設計 &lt;Kevin&gt;');
    expect(html).toContain('再一步就完成訂閱');
  });
});

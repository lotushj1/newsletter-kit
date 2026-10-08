import { describe, expect, it } from 'vitest';
import { buildBrandSignatureHtml } from '../src/core/brand-signature.js';
import { EMAIL_FULLWIDTH_STYLE } from '../src/core/email-image.js';
import { styleTypography, trimEdgeMargins } from '../src/core/email-theme.js';
import { innerEmailHtml, renderEmailLayout, styleRichContent } from '../src/core/render.js';
import { EMPTY_BRAND } from '../src/store/types.js';

function letter(contentHtml: string, extra: Partial<Parameters<typeof renderEmailLayout>[0]> = {}): string {
  return renderEmailLayout({ subject: '主旨', siteName: '凱文設計', contentHtml, ...extra });
}

describe('信件版型', () => {
  it('table 排版、無外部字型與腳本，宣告深淺色', () => {
    const out = letter('<p>正文</p>');
    expect(out).toContain('<table class="nk-canvas" role="presentation"');
    expect(out).toContain('<meta name="color-scheme" content="light dark" />');
    expect(out).toContain('<meta name="supported-color-schemes" content="light dark" />');
    expect(out).toContain('<!--[if mso]>');
    expect(out).not.toMatch(/<link\b/i);
    expect(out).not.toMatch(/@import|@font-face|fonts\.googleapis/i);
    expect(out).not.toMatch(/<script\b/i);
  });

  it('預覽文字隱藏，後面補空白字元', () => {
    const out = letter('<p>正文</p>', { preheader: '這期摘要' });
    const block = /<div class="nk-preheader" style="display:none;[^"]*">([\s\S]*?)<\/div>/.exec(out);
    expect(block?.[1]).toContain('這期摘要');
    expect(block?.[1]).toContain('&#847;');
    expect(letter('<p>正文</p>')).not.toContain('nk-preheader');
  });

  it('刊頭用 siteName，在白卡片之前；有線上閱讀網址才顯示連結', () => {
    const out = letter('<p>正文</p>');
    expect(out.indexOf('凱文設計')).toBeLessThan(out.indexOf('class="nk-card"'));
    expect(out).not.toContain('線上閱讀');
    const withWeb = letter('<p>正文</p>', { webViewUrl: 'https://example.com/archive/a' });
    expect(withWeb).toContain('href="https://example.com/archive/a"');
    expect(withWeb).toContain('線上閱讀');
  });

  it('頁尾帶退訂連結與註記，在白卡片之後', () => {
    const out = letter('<p>正文</p>', {
      unsubscribeUrl: 'https://example.com/unsubscribe?token=x',
      footerNote: '因為你訂閱了才收到',
    });
    const cardAt = out.indexOf('class="nk-card"');
    expect(out.indexOf('href="https://example.com/unsubscribe?token=x"')).toBeGreaterThan(cardAt);
    expect(out).toContain('取消訂閱</a>');
    expect(out).toContain('因為你訂閱了才收到');
  });

  it('滿版圖拆成貼邊列並鎖卡片寬度，封存頁同樣保留', () => {
    const out = letter(
      '<img data-email-fullwidth="1" src="https://example.com/cover.jpg" alt="" /><p>前</p><img data-email-fullwidth="1" src="https://example.com/mid.jpg" alt="" /><p>後</p><img data-email-fullwidth="0" src="https://example.com/in.jpg" alt="" />',
    );
    const bleeds = out.match(/<td style="padding:0;font-size:0;line-height:0;"><img [^>]*>/g) ?? [];
    expect(bleeds).toHaveLength(2);
    for (const row of bleeds) {
      expect(row).toContain('width="600"');
      expect(row).toContain(EMAIL_FULLWIDTH_STYLE);
    }
    expect(out).toMatch(/<img width="520"[^>]*in\.jpg/);
    expect(innerEmailHtml(out).match(/padding:0;font-size:0;line-height:0;/g)).toHaveLength(2);
  });
});

describe('正文排版', () => {
  it('段落、標題、清單、引言、連結都補上 inline style', () => {
    const html = styleRichContent(
      '<h2>標題</h2><p>看 <a href="https://example.com">這裡</a></p><ul><li><p>一</p></li><li><p>二</p></li></ul><blockquote><p>引言</p></blockquote>',
    );
    expect(html).toMatch(/<h2 style="[^"]*font-size:22px[^"]*">/);
    expect(html).toMatch(/<a style="color:#9a5f2c;[^"]*" href=/);
    expect(html).toMatch(/<li style="[^"]*"><p style="margin:0 0 0 0;">一<\/p>/);
    // 最後一個清單項目與引言最後一段不留下外距
    expect(html).toMatch(/<li style="margin:0 0 0 0;[^"]*"><p style="margin:0 0 0 0;">二/);
    expect(html).toMatch(/<blockquote style="[^"]*border-left:2px solid #9a5f2c[^"]*"><p style="margin:0 0 0 0;">引言/);
  });

  it('編輯器的對齊設定保留並蓋過預設值', () => {
    const html = styleTypography('<p style="text-align: center">置中</p>');
    expect(html).toBe('<p style="margin:0 0 20px 0;text-align: center">置中</p>');
  });

  it('簽名表與自帶字型的元件不被改動', () => {
    const signature = buildBrandSignatureHtml({ ...EMPTY_BRAND, writerName: '凱文', tagline: '一句話' });
    expect(styleTypography(signature)).toBe(signature);
    const button = styleRichContent('<div data-email-btn data-href="https://example.com" data-bg="#1c1917">報名</div>');
    expect(button).toContain('class="nk-btn"');
    expect(button).toContain('class="nk-btn-dark"');
    expect(button).toContain('mso-padding-alt:14px 30px');
    const light = styleRichContent('<div data-email-btn data-href="https://example.com" data-bg="#f5f5f4">報名</div>');
    expect(light).not.toContain('nk-btn-dark');
  });

  it('每段內文頭尾的外距交給格子內距', () => {
    const html = trimEdgeMargins(styleTypography('<h2>開頭</h2><p>中間</p><p>結尾</p>'));
    expect(html).toMatch(/^<h2 style="margin:0 0 14px 0;/);
    expect(html).toContain('<p style="margin:0 0 20px 0;">中間</p>');
    expect(html).toContain('<p style="margin:0 0 0 0;">結尾</p>');
  });
});

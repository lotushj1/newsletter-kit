import { describe, expect, it } from 'vitest';
import {
  EMAIL_COVER_STYLE,
  EMAIL_FULLWIDTH_STYLE,
  EMAIL_HERO_STYLE,
  EMAIL_IMAGE_STYLE,
  imageInlineStyle,
  splitBleedSegments,
  splitLeadingHero,
} from '../src/core/email-image.js';
import { innerEmailHtml, renderEmailLayout, styleRichContent } from '../src/core/render.js';

function letter(contentHtml: string): string {
  return renderEmailLayout({
    subject: '測試',
    siteName: '測試電子報',
    contentHtml,
  });
}

describe('圖片滿版／一般', () => {
  it('舊的開頭封面仍抽成貼邊首圖', () => {
    const split = splitLeadingHero(
      '<img data-email-hero="1" src="https://example.com/cover.jpg" alt="封面" /><p>正文</p>',
    );
    expect(split.coverHtml).toContain('cover.jpg');
    expect(split.bodyHtml).toContain('<p>正文</p>');
  });

  it('開頭圖標成一般時不抽成封面', () => {
    const html =
      '<img data-email-hero="1" data-email-fullwidth="0" src="https://example.com/a.jpg" alt="" /><p>正文</p>';
    const split = splitLeadingHero(html);
    expect(split.coverHtml).toBeNull();
    expect(split.bodyHtml).toContain('data-email-fullwidth="0"');
    const out = letter(html);
    expect(out).not.toContain('padding:0;font-size:0;line-height:0;');
    expect(out).toContain(EMAIL_IMAGE_STYLE);
  });

  it('開頭滿版圖即使沒有 hero 也貼齊卡片邊緣', () => {
    const html =
      '<img data-email-fullwidth="1" src="https://example.com/wide.jpg" alt="" /><p>正文</p>';
    const split = splitLeadingHero(html);
    expect(split.coverHtml).toContain('wide.jpg');
    const out = letter(html);
    expect(out).toContain('padding:0;font-size:0;line-height:0;');
    expect(out).toContain(EMAIL_COVER_STYLE);
    expect(out.indexOf(EMAIL_COVER_STYLE)).toBeLessThan(out.indexOf('class="nk-pad"'));
  });

  it('內文滿版圖拆成獨立的 padding:0 列，一般圖留在有左右內距的格子', () => {
    const html =
      '<p>前</p><img data-email-fullwidth="1" src="https://example.com/wide.jpg" alt="" /><p>後</p><img data-email-fullwidth="0" src="https://example.com/narrow.jpg" alt="" />';
    expect(splitBleedSegments(html).map((item) => item.type)).toEqual(['content', 'bleed', 'content']);
    const out = letter(html);
    expect(out).toContain('padding:0;font-size:0;line-height:0;');
    expect(out).toContain(EMAIL_FULLWIDTH_STYLE);
    expect(out).toContain(EMAIL_IMAGE_STYLE);
    const wideAt = out.indexOf('wide.jpg');
    const narrowAt = out.indexOf('narrow.jpg');
    const bleedAt = out.indexOf('padding:0;font-size:0;line-height:0;');
    expect(bleedAt).toBeGreaterThan(-1);
    expect(wideAt).toBeGreaterThan(bleedAt);
    expect(out.slice(bleedAt, wideAt)).not.toContain('class="nk-pad"');
    expect(out.slice(out.lastIndexOf('class="nk-pad"', narrowAt), narrowAt)).toContain(' 40px ');
  });

  it('舊的中段封面仍用固定圓角，不拆成貼邊列', () => {
    const html =
      '<p>正文</p><img data-email-hero="1" src="https://example.com/cover.jpg" alt="封面" width="1200" />';
    const styled = styleRichContent(html);
    expect(styled).toContain(EMAIL_HERO_STYLE);
    const out = letter(html);
    expect(out).not.toContain('padding:0;font-size:0;line-height:0;');
    expect(out).toContain(EMAIL_HERO_STYLE);
  });

  it('inline style 依 data-email-fullwidth 決定', () => {
    expect(imageInlineStyle('<img data-email-fullwidth="1" src="x.jpg">')).toBe(EMAIL_FULLWIDTH_STYLE);
    expect(imageInlineStyle('<img data-email-fullwidth="0" src="x.jpg">')).toBe(EMAIL_IMAGE_STYLE);
    expect(imageInlineStyle('<img data-email-hero="1" src="x.jpg">')).toBe(EMAIL_HERO_STYLE);
  });

  it('公開封存可抽出 body，保留滿版表格列', () => {
    const html = letter(
      '<p>哈囉</p><img data-email-fullwidth="1" src="https://example.com/wide.jpg" alt="" />',
    );
    const inner = innerEmailHtml(html);
    expect(inner).not.toContain('<!doctype');
    expect(inner).toContain('哈囉');
    expect(inner).toContain('padding:0;font-size:0;line-height:0;');
    expect(inner).toContain(EMAIL_FULLWIDTH_STYLE);
  });
});

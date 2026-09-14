import { describe, expect, it } from 'vitest';
import {
  contrastFg,
  emailButtonMarkup,
  emailButtonNodeStyle,
  normalizeEmailButtonStyle,
  sanitizeHex,
} from '../src/core/email-button.js';
import { styleRichContent } from '../src/core/render.js';

describe('email button style', () => {
  it('只接受 hex，其餘回退預設', () => {
    expect(sanitizeHex('#ff00aa', '#111')).toBe('#ff00aa');
    expect(sanitizeHex('red', '#1c1917')).toBe('#1c1917');
    expect(sanitizeHex('url(javascript:alert(1))', '#1c1917')).toBe('#1c1917');
  });

  it('淺底用深字、深底用淺字', () => {
    expect(contrastFg('#ffffff')).toBe('#1c1917');
    expect(contrastFg('#1c1917')).toBe('#fafaf9');
  });

  it('數字會夾在合理範圍', () => {
    const style = normalizeEmailButtonStyle({ borderWidth: 99, radius: -4, bg: '#abc' });
    expect(style.borderWidth).toBe(16);
    expect(style.radius).toBe(0);
    expect(style.bg).toBe('#abc');
  });

  it('寄出時把資料屬性轉成 inline style', () => {
    const html = styleRichContent(
      '<div data-email-btn="1" data-href="https://example.com" data-bg="#111111" data-border="2" data-border-color="#eeeeee" data-radius="12">Go</div>',
    );
    expect(html).toContain('background:#111111');
    expect(html).toContain('background:#eeeeee');
    expect(html).toContain('padding:2px');
    expect(html).toContain('border-radius:12px');
    expect(html).toContain('border-radius:14px');
    expect(html).toContain('Go');
  });

  it('空的建議置入圖片區塊寄出時會拿掉', () => {
    expect(styleRichContent('<p>正文</p><figure data-email-image-slot="1" data-label="建議置入圖片">建議置入圖片</figure>')).toBe(
      '<p>正文</p>',
    );
  });

  it('封面圖會補上信箱吃得下的寬度', () => {
    const html = styleRichContent(
      '<img data-email-hero="1" src="https://example.com/cover.jpg" alt="封面" width="1200" />',
    );
    expect(html).toContain('style="width:100%;max-width:420px;height:auto;display:block;border:0;border-radius:10px;margin:0 auto 20px;"');
    expect(html).toContain('https://example.com/cover.jpg');
  });

  it('外框畫在填色外側', () => {
    const style = normalizeEmailButtonStyle({
      bg: '#fff7ed',
      borderWidth: 3,
      borderColor: '#c2410c',
      radius: 24,
    });
    expect(emailButtonNodeStyle(style)).toContain('box-shadow:0 0 0 3px #c2410c');
    expect(emailButtonNodeStyle(style)).toContain('border:0');
    const markup = emailButtonMarkup('https://example.com', 'Go', style);
    expect(markup).toContain('padding:3px');
    expect(markup).toContain('border-radius:27px');
    expect(markup).not.toContain('border:3px solid');
  });
});

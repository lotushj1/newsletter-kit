// @vitest-environment happy-dom
import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';
import { emailContentExtensions } from '../admin/src/components/editor/extensions.js';
import { BUILTIN_CAMPAIGN_STARTERS, EMPTY_STARTER_BODY } from '../src/core/campaign-starters.js';
import { confirmEmailContentHtml } from '../src/core/system-emails.js';
import { renderPreviewEmail } from '../src/core/preview-email.js';
import { EMPTY_BRAND } from '../src/store/types.js';

const editors: Editor[] = [];
afterEach(() => {
  while (editors.length) editors.pop()!.destroy();
});

/** 跟後台編輯器同一組 extension：載入模板、什麼都不改、存回 HTML。 */
function throughEditor(html: string): string {
  const editor = new Editor({ extensions: emailContentExtensions(), content: html });
  editors.push(editor);
  return editor.getHTML();
}

/**
 * 編輯器會替連結補 target／rel、替段落補預設的靠左對齊，都跟版面無關。
 * 結尾的 {{signature}} 會被包成段落，這是改版前就有的行為，這裡不算進版面差異。
 */
function normalize(html: string): string {
  return html
    .replace(/<p(?:\s[^>]*)?>(\{\{signature\}\})<\/p>/g, '$1')
    .replace(/\s(?:target|rel)="[^"]*"/g, '')
    .replace(/\sstyle="text-align: left;"/g, '')
    .replace(/text-align: ?left;/g, '');
}

/** 跟後台預覽同一條路：變數 → 簽名 → 版型。 */
function letter(html: string, imageSlots?: 'placeholder'): string {
  return normalize(
    renderPreviewEmail({ bodyHtml: normalize(html), siteName: '凱文設計', brand: EMPTY_BRAND, imageSlots }).html,
  );
}

const BODIES = [
  ...BUILTIN_CAMPAIGN_STARTERS.map((item) => [item.id, item.bodyHtml] as const),
  ['blank', EMPTY_STARTER_BODY] as const,
  ['confirm', confirmEmailContentHtml('凱文設計', 'https://news.example.com/confirm?token=t')] as const,
];

describe('模板經過編輯器存回後版面不變', () => {
  it.each(BODIES)('%s', (_id, body) => {
    const saved = throughEditor(body);
    // 區塊屬性一個都沒被洗掉。
    const count = (html: string, re: RegExp) => html.match(re)?.length ?? 0;
    expect(count(saved, /data-email-style="/g)).toBe(count(body, /data-email-style="/g));
    expect(count(saved, /data-email-tone="/g)).toBe(count(body, /data-email-tone="/g));
    expect(count(saved, /data-email-image-slot/g)).toBe(count(body, /data-email-image-slot/g));
    expect(count(saved, /data-email-btn/g)).toBe(count(body, /data-email-btn/g));
    // 寄出版與縮圖版都跟原模板一模一樣。
    expect(letter(saved)).toBe(letter(body));
    expect(letter(saved, 'placeholder')).toBe(letter(body, 'placeholder'));
    // 再存一次也不會變。
    expect(throughEditor(saved)).toBe(saved);
  });

  it('不認得的區塊樣式與點綴色會被丟掉，不會原樣存回', () => {
    const saved = throughEditor(
      '<p data-email-style="evil" data-email-tone="neon">a</p><blockquote data-email-style="kicker"><p>b</p></blockquote>',
    );
    expect(saved).not.toContain('evil');
    expect(saved).not.toContain('neon');
    // kicker 只能掛在段落上，不能掛在引言上。
    expect(saved).not.toContain('<blockquote data-email-style');
  });

  it('在標籤段落按 Enter，下一段不會沿用標籤樣式', () => {
    const editor = new Editor({
      extensions: emailContentExtensions(),
      content: '<p data-email-style="kicker" data-email-tone="sage">01　觀察</p>',
    });
    editors.push(editor);
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    editor.commands.splitBlock();
    editor.commands.insertContent('正文');
    expect(normalize(editor.getHTML())).toBe('<p data-email-style="kicker" data-email-tone="sage">01　觀察</p><p>正文</p>');
  });
});

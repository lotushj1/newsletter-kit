// @vitest-environment happy-dom
import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';
import { insertEmailBlock } from '../admin/src/components/editor/blocks.js';
import { emailContentExtensions } from '../admin/src/components/editor/extensions.js';
import { BUILTIN_CAMPAIGN_STARTERS, EMPTY_STARTER_BODY } from '../src/core/campaign-starters.js';
import { EMAIL_BLOCK_SNIPPETS } from '../src/core/email-block-snippets.js';
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
 * 結尾的 {{signature}} 會被包成段落；這裡不抹掉，寄出版要自己處理到跟原模板一樣。
 */
function normalize(html: string): string {
  return html
    .replace(/\s(?:target|rel)="[^"]*"/g, '')
    .replace(/\sstyle="text-align: left;"/g, '')
    .replace(/text-align: ?left;/g, '');
}

/** 跟後台預覽同一條路：變數 → 簽名 → 版型。 */
function letter(html: string, imageSlots?: 'placeholder'): string {
  return normalize(
    renderPreviewEmail({ bodyHtml: normalize(html), siteName: '凱文設計', brand: SAMPLE_BRAND, imageSlots }).html,
  );
}

/** 有簽名，才看得出 {{signature}} 被包成段落時多出來的空白。 */
const SAMPLE_BRAND = { ...EMPTY_BRAND, writerName: '凱文 Kevin', websiteUrl: 'https://example.com' };

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

describe('/ 選單插入的版面區塊', () => {
  /** 跟編輯器同一條路：游標停在空段落、按選單項目插入，再存回 HTML。 */
  function insertInto(id: string, content = '<p>前文</p><p></p>'): string {
    const editor = new Editor({ extensions: emailContentExtensions(), content });
    editors.push(editor);
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    expect(insertEmailBlock(editor, id)).toBe(true);
    return editor.getHTML();
  }

  const RENDERED: Record<string, RegExp> = {
    kicker: /<p class="nk-kicker nk-tone-ink"/,
    lead: /<p class="nk-lead /,
    step: /<table class="nk-stephead nk-tone-ink"[\s\S]*?<td class="nk-step"[^>]*>1<\/td>/,
    steps: /<table class="nk-steps nk-tone-ink"/,
    panel: /<table class="nk-panel nk-tone-ink"[\s\S]*?<td class="nk-key"[^>]*>日期<\/td>/,
    card: /<table class="nk-box nk-tone-ink"/,
    recap: /<table class="nk-recap nk-tone-ink"[\s\S]*?class="nk-recap-title"[\s\S]*?class="nk-check"/,
    tip: /<table class="nk-tip nk-tone-ink"/,
    pull: /<table class="nk-pull nk-tone-ink"/,
    meta: /<p class="nk-meta nk-tone-ink"/,
    note: /<p class="nk-note /,
    ornament: /<p class="nk-orn nk-tone-ink"/,
  };

  it('每個區塊都有對應的寄出樣子', () => {
    expect(EMAIL_BLOCK_SNIPPETS.map((item) => item.id).sort()).toEqual(Object.keys(RENDERED).sort());
  });

  it.each(EMAIL_BLOCK_SNIPPETS.map((item) => [item.id, item.label] as const))('%s（%s）', (id) => {
    const snippet = EMAIL_BLOCK_SNIPPETS.find((item) => item.id === id)!;
    const saved = insertInto(id);
    // 插入的就是預設內容：空段落被換掉、前文還在，跟直接載入那段 HTML 一樣。
    expect(saved).toBe(throughEditor(`<p>前文</p>${snippet.html('ink')}`));
    expect(saved).toContain(`data-email-style="${id}"`);
    // 存回、再載入都不變。
    expect(throughEditor(saved)).toBe(saved);
    // 寄出版（空位拿掉）與縮圖版都跟直接寫 HTML 一模一樣，且變成 table／inline style。
    const body = `<p>前文</p>${snippet.html('ink')}{{signature}}`;
    expect(letter(`${saved}{{signature}}`)).toBe(letter(body));
    expect(letter(`${saved}{{signature}}`, 'placeholder')).toBe(letter(body, 'placeholder'));
    const sent = letter(saved);
    expect(sent).toMatch(RENDERED[id]!);
    expect(sent).not.toContain('data-email-style');
    expect(sent).not.toContain('<blockquote');
  });

  it('插入的區塊沿用信裡已有的點綴色', () => {
    const saved = insertInto('panel', '<p data-email-style="kicker" data-email-tone="plum">新推出</p><p></p>');
    expect(saved).toContain('<blockquote data-email-style="panel" data-email-tone="plum">');
    expect(letter(saved)).toMatch(/<table class="nk-panel nk-tone-plum"[^>]*background:#f6edf1/);
  });

  it('步驟標題依出現順序自動編號', () => {
    const html = throughEditor(
      '<h2 data-email-style="step" data-email-tone="teal">一</h2><p>a</p><h2 data-email-style="step" data-email-tone="teal">二</h2>',
    );
    const numbers = [...letter(html).matchAll(/<td class="nk-step"[^>]*>(\d+)<\/td>/g)].map((match) => match[1]);
    expect(numbers).toEqual(['1', '2']);
  });
});

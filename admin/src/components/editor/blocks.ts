import type { Editor } from '@tiptap/core';
import { EMAIL_BLOCK_SNIPPETS } from '../../../../src/core/email-block-snippets.js';
import { isEmailTone, type EmailTone } from '../../../../src/core/email-theme.js';

/** 新插入的區塊沿用信裡第一個點綴色，跟模板的配色一致；整封都沒有就用中性的 ink。 */
export function documentTone(editor: Editor): EmailTone {
  let tone: EmailTone = 'ink';
  let found = false;
  editor.state.doc.descendants((node) => {
    if (found) return false;
    const value = node.attrs.emailTone;
    if (typeof value === 'string' && isEmailTone(value)) {
      tone = value;
      found = true;
      return false;
    }
    return true;
  });
  return tone;
}

/** / 選單插入版面區塊。內容是〔〕占位，插入後直接改字。 */
export function insertEmailBlock(editor: Editor, id: string): boolean {
  const snippet = EMAIL_BLOCK_SNIPPETS.find((item) => item.id === id);
  if (!snippet) return false;
  return editor
    .chain()
    .focus(undefined, { scrollIntoView: false })
    .insertContent(snippet.html(documentTone(editor)))
    .run();
}

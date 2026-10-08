import { schema } from '@tiptap/pm/schema-basic';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { describe, expect, it } from 'vitest';
import { planSelectionReplacement } from '../admin/src/components/editor/replace-selection.ts';

const paragraph = (text?: string) =>
  text ? schema.node('paragraph', null, schema.text(text)) : schema.node('paragraph');

function apply(docText: string[], from: number, to: number, blocks: ReturnType<typeof paragraph>[]) {
  const doc = schema.node('doc', null, docText.map((text) => paragraph(text)));
  const selection = TextSelection.create(doc, from, to);
  const state = EditorState.create({ doc, selection });
  const plan = planSelectionReplacement(selection, schema.node('doc', null, blocks).content);
  expect(plan).not.toBeNull();
  return state.tr.replaceWith(plan!.from, plan!.to, plan!.content).doc.toString();
}

describe('改寫取代', () => {
  it('整段換成一個段落時，不會在前面留下空段', () => {
    const result = apply(['這是十天後的最新消息內容。', '{{signature}}'], 1, '這是十天後的最新消息內容。'.length + 1, [
      paragraph('改寫測試'),
    ]);
    expect(result).toBe('doc(paragraph("改寫測試"), paragraph("{{signature}}"))');
  });

  it('選取句中幾個字時，改寫留在同一段，前後不拆段', () => {
    const source = '這是十天後的最新消息內容。';
    const from = source.indexOf('十天') + 1;
    const result = apply([source, '{{signature}}'], from, from + 2, [paragraph('兩週')]);
    expect(result).toBe('doc(paragraph("這是兩週後的最新消息內容。"), paragraph("{{signature}}"))');
  });

  it('去掉只有空白的前段', () => {
    const result = apply(['原文', '{{signature}}'], 1, 3, [
      paragraph('\u00a0'),
      paragraph('改寫測試'),
      paragraph(' '),
    ]);
    expect(result).toBe('doc(paragraph("改寫測試"), paragraph("{{signature}}"))');
  });

  it('去掉改寫結果前後的換行與空段', () => {
    const result = apply(['原文', '{{signature}}'], 1, 3, [
      paragraph(),
      paragraph('\n改寫測試\n'),
      paragraph(),
    ]);
    expect(result).toBe('doc(paragraph("改寫測試"), paragraph("{{signature}}"))');
  });

  it('改成多段時取代整個段落，不留空殼', () => {
    const result = apply(['原文', '{{signature}}'], 1, 3, [paragraph('第一段'), paragraph('第二段')]);
    expect(result).toBe('doc(paragraph("第一段"), paragraph("第二段"), paragraph("{{signature}}"))');
  });

  it('改成標題時換成標題，不把標題塞進原段落', () => {
    const doc = schema.node('doc', null, [paragraph('原文'), paragraph('{{signature}}')]);
    const selection = TextSelection.create(doc, 1, 3);
    const heading = schema.node('heading', { level: 2 }, schema.text('標題'));
    const state = EditorState.create({ doc, selection });
    const plan = planSelectionReplacement(selection, schema.node('doc', null, [heading]).content);
    const next = state.tr.replaceWith(plan!.from, plan!.to, plan!.content).doc.toString();
    expect(next).toBe('doc(heading("標題"), paragraph("{{signature}}"))');
  });
});

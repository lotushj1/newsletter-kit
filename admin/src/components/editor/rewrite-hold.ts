import { Extension } from '@tiptap/core';
import type { Node as ProseNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export interface RewriteHoldRange {
  from: number;
  to: number;
}

const key = new PluginKey<DecorationSet>('rewriteHold');

function holdDecorations(doc: ProseNode, range: RewriteHoldRange | null): DecorationSet {
  if (!range) return DecorationSet.empty;
  const max = doc.content.size;
  const start = Math.max(0, Math.min(range.from, max));
  const end = Math.max(start, Math.min(range.to, max));
  if (start === end) return DecorationSet.empty;
  const found: Decoration[] = [];
  doc.nodesBetween(start, end, (node, pos) => {
    if (!node.isTextblock) return;
    const from = Math.max(start, pos + 1);
    const to = Math.min(end, pos + node.nodeSize - 1);
    if (from < to) found.push(Decoration.inline(from, to, { class: 'tt-rewrite-hold' }));
  });
  return found.length ? DecorationSet.create(doc, found) : DecorationSet.empty;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    rewriteHold: {
      setRewriteHold: (range: RewriteHoldRange | null) => ReturnType;
    };
  }
}

/** 輸入框拿走焦點時，用這層藍色把原本的選取留在畫面上。 */
export const RewriteHold = Extension.create({
  name: 'rewriteHold',
  addCommands() {
    return {
      setRewriteHold:
        (range) =>
        ({ state, tr, dispatch }) => {
          const current = key.getState(state) ?? DecorationSet.empty;
          const next = holdDecorations(state.doc, range);
          if (current.eq(next)) return false;
          if (dispatch) dispatch(tr.setMeta(key, range));
          return true;
        },
    };
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, old) {
            const meta = tr.getMeta(key) as RewriteHoldRange | null | undefined;
            if (meta === undefined) return old.map(tr.mapping, tr.doc);
            return holdDecorations(tr.doc, meta);
          },
        },
        props: {
          decorations(state) {
            return key.getState(state);
          },
        },
      }),
    ];
  },
});

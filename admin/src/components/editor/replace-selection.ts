import { Fragment, type Node as ProseNode } from '@tiptap/pm/model';
import type { Selection } from '@tiptap/pm/state';

export interface SelectionReplacement {
  from: number;
  to: number;
  content: Fragment;
}

function isHardBreak(node: ProseNode): boolean {
  return node.type.name === 'hardBreak' || node.type.name === 'hard_break';
}

function trimEdgeText(node: ProseNode, edge: 'start' | 'end'): ProseNode | null {
  if (!node.isText || !node.text) return node;
  if (!node.text.replace(/[\s\u00a0]/g, '')) return null;
  const text = edge === 'start' ? node.text.replace(/^[\n\r]+/, '') : node.text.replace(/[\n\r]+$/, '');
  if (!text) return null;
  if (text === node.text) return node;
  return node.type.schema.text(text, node.marks);
}

/** 去掉片段前後的換行與空段落，避免改寫結果在原文上下多出空白行。 */
export function normalizeReplacement(fragment: Fragment): Fragment {
  const blocks: ProseNode[] = [];
  fragment.forEach((node) => {
    blocks.push(node.isTextblock ? node.copy(trimInlineEdges(node.content)) : node);
  });
  while (blocks.length > 0 && isBlankTextblock(blocks[0]!)) blocks.shift();
  while (blocks.length > 0 && isBlankTextblock(blocks[blocks.length - 1]!)) blocks.pop();
  return Fragment.from(blocks);
}

function trimInlineEdges(fragment: Fragment): Fragment {
  const nodes: ProseNode[] = [];
  fragment.forEach((node) => nodes.push(node));
  let changed = true;
  while (changed && nodes.length > 0) {
    changed = false;
    const first = nodes[0]!;
    if (isHardBreak(first)) {
      nodes.shift();
      changed = true;
      continue;
    }
    if (first.isText) {
      const next = trimEdgeText(first, 'start');
      if (!next) {
        nodes.shift();
        changed = true;
        continue;
      }
      if (next !== first) {
        nodes[0] = next;
        changed = true;
        continue;
      }
    }
    const last = nodes[nodes.length - 1]!;
    if (isHardBreak(last)) {
      nodes.pop();
      changed = true;
      continue;
    }
    if (last.isText) {
      const next = trimEdgeText(last, 'end');
      if (!next) {
        nodes.pop();
        changed = true;
        continue;
      }
      if (next !== last) {
        nodes[nodes.length - 1] = next;
        changed = true;
      }
    }
  }
  return Fragment.from(nodes);
}

function isBlankTextblock(node: ProseNode): boolean {
  return node.isTextblock && trimInlineEdges(node.content).size === 0;
}

function sameTextblock(a: ProseNode, b: ProseNode): boolean {
  if (a.type !== b.type) return false;
  if (a.type.name === 'heading' && a.attrs.level !== b.attrs.level) return false;
  return true;
}

export function planSelectionReplacement(selection: Selection, fragment: Fragment): SelectionReplacement | null {
  if (selection.empty) return null;
  const content = normalizeReplacement(fragment);
  if (!content.childCount) return null;

  const { $from, $to } = selection;
  const only = content.childCount === 1 ? content.firstChild : null;
  if (only?.isTextblock && $from.sameParent($to) && $from.parent.isTextblock && sameTextblock(only, $from.parent)) {
    if (!only.content.size) return null;
    return { from: selection.from, to: selection.to, content: only.content };
  }

  let from = selection.from;
  let to = selection.to;
  if ($from.parent.isTextblock && $from.parentOffset === 0 && $from.depth > 0) from = $from.before($from.depth);
  if ($to.parent.isTextblock && $to.parentOffset === $to.parent.content.size && $to.depth > 0) to = $to.after($to.depth);
  return { from, to, content };
}

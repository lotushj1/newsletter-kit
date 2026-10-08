/**
 * 信件版型的設計 token 與正文排版。版型、按鈕、簽名都從這裡取值，
 * 想換整體風格只改這一份。
 */

/** 系統字，中英混排時英文走各平台的 UI 字，中文落到蘋方／思源／正黑。 */
export const EMAIL_FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue','PingFang TC','Noto Sans TC','Microsoft JhengHei',sans-serif";

export const EMAIL_FONT_MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace";

/** 暖灰紙感底色、近黑文字，強調色只用在連結與引言線。 */
export const EMAIL_COLORS = {
  canvas: '#f3f1ec',
  card: '#ffffff',
  line: '#e6e1d8',
  ink: '#171614',
  text: '#2b2825',
  soft: '#57514a',
  muted: '#756e64',
  wash: '#f6f4ef',
  accent: '#9a5f2c',
} as const;

export const EMAIL_BODY_SIZE = 16;
export const EMAIL_BODY_LINE = 1.8;
export const EMAIL_BODY_TRACKING = '0.02em';

const C = EMAIL_COLORS;
const HEADING = `font-family:${EMAIL_FONT};color:${C.ink};`;

/** margin 一律寫成四值，方便之後把頭尾的外距歸零。 */
const ELEMENT_STYLES: Record<string, string> = {
  p: 'margin:0 0 20px 0;',
  h1: `margin:0 0 20px 0;${HEADING}font-size:30px;line-height:1.4;font-weight:700;letter-spacing:0.01em;`,
  h2: `margin:44px 0 14px 0;${HEADING}font-size:22px;line-height:1.5;font-weight:700;letter-spacing:0.02em;`,
  h3: `margin:36px 0 10px 0;${HEADING}font-size:18px;line-height:1.55;font-weight:700;letter-spacing:0.02em;`,
  h4: `margin:28px 0 8px 0;${HEADING}font-size:16px;line-height:1.6;font-weight:700;letter-spacing:0.02em;`,
  h5: `margin:28px 0 8px 0;${HEADING}font-size:14px;line-height:1.6;font-weight:700;letter-spacing:0.08em;color:${C.soft};`,
  h6: `margin:28px 0 8px 0;${HEADING}font-size:13px;line-height:1.6;font-weight:700;letter-spacing:0.08em;color:${C.muted};`,
  ul: 'margin:0 0 20px 0;padding:0 0 0 1.4em;',
  ol: 'margin:0 0 20px 0;padding:0 0 0 1.4em;',
  li: 'margin:0 0 8px 0;padding:0 0 0 0.25em;',
  blockquote: `margin:32px 0 32px 0;padding:2px 0 2px 20px;border-left:2px solid ${C.accent};color:${C.soft};font-size:17px;line-height:1.85;`,
  pre: `margin:0 0 20px 0;padding:16px 18px;background:${C.wash};border-radius:6px;font-family:${EMAIL_FONT_MONO};font-size:13px;line-height:1.65;letter-spacing:0;white-space:pre-wrap;word-wrap:break-word;color:${C.text};`,
  figure: 'margin:28px 0 28px 0;',
  figcaption: `margin:10px 0 0 0;font-size:13px;line-height:1.6;color:${C.muted};text-align:center;`,
  a: `color:${C.accent};text-decoration:underline;text-underline-offset:3px;`,
  strong: `font-weight:700;color:${C.ink};`,
  b: `font-weight:700;color:${C.ink};`,
  code: `padding:2px 5px;background:${C.wash};border-radius:4px;font-family:${EMAIL_FONT_MONO};font-size:0.88em;letter-spacing:0;`,
};

/** 清單項目、引言裡的段落不要再帶段落間距。 */
const NESTED_STYLES: Record<string, Record<string, string>> = {
  li: {
    p: 'margin:0 0 0 0;',
    ul: 'margin:8px 0 0 0;padding:0 0 0 1.4em;',
    ol: 'margin:8px 0 0 0;padding:0 0 0 1.4em;',
  },
  blockquote: { p: 'margin:0 0 12px 0;' },
  pre: { code: 'font-family:inherit;font-size:inherit;' },
};

/** 有子元素時，最後一個子元素的下外距歸零。 */
const TRIM_LAST_CHILD = new Set(['ul', 'ol', 'li', 'blockquote', 'figure']);

const VOID_TAGS = new Set(['img', 'br', 'hr', 'meta', 'input', 'source', 'wbr', 'col', 'area', 'link']);
const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;

interface Frame {
  name: string;
  skip: boolean;
  children: number[];
}

const MARGIN4_RE = /(\sstyle="[^"]*?)margin:([^\s;"]+) ([^\s;"]+) ([^\s;"]+) ([^\s;"]+);/i;

/** 把開頭標籤四值 margin 的上或下改成 0；不是四值寫法就不動。 */
export function zeroMargin(tag: string, side: 'top' | 'bottom'): string {
  return tag.replace(MARGIN4_RE, (_m, lead: string, t: string, r: string, b: string, l: string) =>
    side === 'top' ? `${lead}margin:0 ${r} ${b} ${l};` : `${lead}margin:${t} ${r} 0 ${l};`,
  );
}

function styleTag(tag: string, name: string, attrs: string, parent: string | undefined): string {
  const base = (parent ? NESTED_STYLES[parent]?.[name] : undefined) ?? ELEMENT_STYLES[name];
  if (!base) return tag;
  const existing = /\sstyle\s*=\s*"([^"]*)"/i.exec(attrs);
  if (!existing) return tag.replace(new RegExp(`^<${name}`, 'i'), `<${name} style="${base}"`);
  // 已經自帶字型的（按鈕、簽名、影音連結）是別的元件，不覆蓋。
  if (/font/i.test(existing[1] ?? '')) return tag;
  // 編輯器的對齊等設定放後面，讓它們蓋過預設值。
  const merged = `${base}${(existing[1] ?? '').trim()}`;
  return tag.replace(existing[0], ` style="${merged}"`);
}

function walk(html: string, styled: boolean): { tokens: string[]; rootChildren: number[] } {
  const tokens: string[] = [];
  const root: Frame = { name: '#root', skip: false, children: [] };
  const stack: Frame[] = [root];
  let last = 0;
  TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TAG_RE.exec(html))) {
    if (match.index > last) tokens.push(html.slice(last, match.index));
    last = match.index + match[0].length;
    const [tag, closing, rawName, attrs = ''] = match;
    const name = (rawName ?? '').toLowerCase();
    const parent = stack[stack.length - 1]!;
    if (closing) {
      const at = stack.map((frame) => frame.name).lastIndexOf(name);
      if (at > 0) {
        while (stack.length > at) {
          const frame = stack.pop()!;
          const lastChild = frame.children[frame.children.length - 1];
          if (styled && !frame.skip && TRIM_LAST_CHILD.has(frame.name) && lastChild !== undefined) {
            tokens[lastChild] = zeroMargin(tokens[lastChild]!, 'bottom');
          }
        }
      }
      tokens.push(tag);
      continue;
    }
    const selfClosing = VOID_TAGS.has(name) || /\/\s*$/.test(attrs);
    const out = styled && !parent.skip ? styleTag(tag, name, attrs, parent.name) : tag;
    tokens.push(out);
    if (selfClosing) continue;
    parent.children.push(tokens.length - 1);
    stack.push({
      name,
      skip: parent.skip || /data-email-signature/i.test(attrs),
      children: [],
    });
  }
  if (last < html.length) tokens.push(html.slice(last));
  return { tokens, rootChildren: root.children };
}

/**
 * 段落、標題、清單、引言、連結、程式碼補上 inline style。
 * 只動沒有自帶字型的元素，簽名表整塊略過。
 */
export function styleTypography(html: string): string {
  return walk(html, true).tokens.join('');
}

/** 每一段內文的第一個元素去掉上外距、最後一個去掉下外距，留白交給格子內距。 */
export function trimEdgeMargins(html: string): string {
  const { tokens, rootChildren } = walk(html, false);
  const first = rootChildren[0];
  const lastChild = rootChildren[rootChildren.length - 1];
  if (first !== undefined) tokens[first] = zeroMargin(tokens[first]!, 'top');
  if (lastChild !== undefined) tokens[lastChild] = zeroMargin(tokens[lastChild]!, 'bottom');
  return tokens.join('');
}

/**
 * 每種信件各一個點綴色，只用在標籤、編號、資訊面板與按鈕；底色、字色仍共用上面那組。
 * dark* 是深色模式下的替換值。
 */
export const EMAIL_TONES = {
  clay: { accent: '#9a5f2c', tint: '#f7f0e7', rule: '#e8d9c6', darkAccent: '#dfa877', darkTint: '#2a241e' },
  sage: { accent: '#3f6b58', tint: '#eef3ef', rule: '#d2dfd6', darkAccent: '#8fc1a8', darkTint: '#1f2622' },
  vermilion: { accent: '#ad4329', tint: '#faefe9', rule: '#efd2c6', darkAccent: '#ec9a80', darkTint: '#2c201c' },
  indigo: { accent: '#34507a', tint: '#eef1f6', rule: '#d4dbe7', darkAccent: '#9db4d8', darkTint: '#1e222a' },
  ink: { accent: '#6b5d4f', tint: '#f6f4ef', rule: '#e6e1d8', darkAccent: '#bfb3a5', darkTint: '#24221f' },
} as const;

export type EmailTone = keyof typeof EMAIL_TONES;

export function isEmailTone(value: string): value is EmailTone {
  return Object.prototype.hasOwnProperty.call(EMAIL_TONES, value);
}

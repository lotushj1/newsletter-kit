/**
 * 各類型信件用的版面區塊：標籤、導言、附註、資訊列、提示框、資訊面板、推薦卡片、引言、重點清單、
 * 步驟清單、步驟標題、裝飾分隔。
 *
 * 編輯器只多存兩個屬性：`data-email-style`（哪種區塊）與 `data-email-tone`（哪個點綴色），
 * 掛在段落、標題、引言、編號清單與分隔線上，所以使用者照常打字、按 Enter 都不會把版面洗掉。
 * 寄出時在這裡換成 table 與 inline style。
 */
import { applyImgStyle, setImgWidth } from './email-image.js';
import { EMAIL_COLORS, EMAIL_FONT, EMAIL_TONES, isEmailTone, zeroMargin, type EmailTone } from './email-theme.js';

/** 每種節點可用的區塊樣式。編輯器的 parseHTML 也用這份白名單。 */
export const EMAIL_BLOCK_STYLES = {
  paragraph: ['kicker', 'lead', 'note', 'meta', 'tip'],
  heading: ['step'],
  blockquote: ['panel', 'card', 'pull', 'recap'],
  orderedList: ['steps'],
  horizontalRule: ['ornament'],
} as const;

export const EMAIL_TONE_NAMES = Object.keys(EMAIL_TONES) as EmailTone[];

const C = EMAIL_COLORS;
const F = `font-family:${EMAIL_FONT};`;
/** 卡片內圖文並排時的縮圖寬度。 */
export const EMAIL_CARD_THUMB = 148;

const attrOf = (raw: string, name: string): string =>
  new RegExp(`\\s${name}="([^"]*)"`, 'i').exec(raw)?.[1] ?? '';

function toneOf(attrs: string, fallback: EmailTone = 'clay'): { name: EmailTone } & (typeof EMAIL_TONES)[EmailTone] {
  const raw = attrOf(attrs, 'data-email-tone');
  const name = isEmailTone(raw) ? raw : fallback;
  return { name, ...EMAIL_TONES[name] };
}

/** 編輯器的對齊會寫成 style="text-align:…"，保留下來。 */
function alignOf(attrs: string): string {
  const match = /text-align:\s*(left|center|right|justify)/i.exec(attrOf(attrs, 'style'));
  return match ? `text-align:${match[1]!.toLowerCase()};` : '';
}

/** 區塊裡的連結改用該類型的點綴色。 */
function tintLinks(html: string, color: string): string {
  return html.replace(/<a\b(?![^>]*\sstyle=)([^>]*)>/gi, `<a$1 style="color:${color};">`);
}

type Child = { tag: string; attrs: string; inner: string; outer: string };

/** 拆出引言、清單項目裡第一層的段落、標題、圖片。 */
function blockChildren(html: string): Child[] {
  const out: Child[] = [];
  const re = /<img\b[^>]*>|<(p|h[1-6]|ul|ol|table|div|figure)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    if (match[0].toLowerCase().startsWith('<img')) {
      out.push({ tag: 'img', attrs: '', inner: '', outer: match[0] });
    } else {
      out.push({ tag: match[1]!.toLowerCase(), attrs: match[2] ?? '', inner: match[3] ?? '', outer: match[0] });
    }
  }
  return out;
}

/** 段落裡只有一張圖時（舊編輯器或貼上的內容），當成圖片。 */
function asImage(child: Child): string | null {
  if (child.tag === 'img') return child.outer;
  if (child.tag !== 'p') return null;
  const match = /^\s*(<img\b[^>]*>)\s*$/i.exec(child.inner);
  return match?.[1] ?? null;
}

const TABLE = 'role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"';

const PARAGRAPH_STYLES: Record<string, (tone: ReturnType<typeof toneOf>) => string> = {
  kicker: (t) =>
    `margin:36px 0 10px 0;${F}font-size:12px;line-height:1.6;font-weight:700;letter-spacing:0.18em;color:${t.accent};`,
  lead: () => `margin:0 0 24px 0;${F}font-size:18px;line-height:1.75;letter-spacing:0.02em;color:${C.ink};`,
  note: () => `margin:24px 0 20px 0;${F}font-size:14px;line-height:1.75;letter-spacing:0.02em;color:${C.muted};`,
  meta: (t) =>
    `margin:28px 0 28px 0;padding:12px 0 12px 0;border-top:1px solid ${t.rule};border-bottom:1px solid ${t.rule};${F}font-size:13px;line-height:1.7;letter-spacing:0.08em;color:${C.soft};`,
};

/** 提示框：淺底色加左側色條。Outlook 不吃段落的內距，所以包成表格。 */
function tipBlock(attrs: string, inner: string): string {
  const tone = toneOf(attrs);
  return `<table class="nk-tip nk-tone-${tone.name}" ${TABLE} style="width:100%;margin:4px 0 28px 0;border-collapse:separate;"><tr><td class="nk-tip-cell" style="padding:14px 18px 14px 16px;background:${tone.tint};border-left:3px solid ${tone.accent};border-radius:0 8px 8px 0;${F}font-size:14px;line-height:1.75;letter-spacing:0.02em;color:${C.soft};${alignOf(attrs)}">${tintLinks(inner, tone.accent)}</td></tr></table>`;
}

function styleParagraphs(html: string): string {
  const withTips = html.replace(
    /<p\b([^>]*\sdata-email-style="tip"[^>]*)>([\s\S]*?)<\/p>/gi,
    (_match, attrs: string, inner: string) => tipBlock(attrs, inner),
  );
  return withTips.replace(/<p\b([^>]*\sdata-email-style="([a-z]+)"[^>]*)>/gi, (match, attrs: string, kind: string) => {
    const build = PARAGRAPH_STYLES[kind];
    if (!build) return match;
    const tone = toneOf(attrs);
    return `<p class="nk-${kind} nk-tone-${tone.name}" style="${build(tone)}${alignOf(attrs)}">`;
  });
}

/** 「日期　某年某月」：開頭的粗體當欄位名，其餘當內容。 */
function panelRow(child: Child, tone: ReturnType<typeof toneOf>, first: boolean): string {
  const line = first ? '' : `border-top:1px solid ${tone.rule};`;
  const kv = /^\s*<strong>([\s\S]*?)<\/strong>([\s\S]*)$/i.exec(child.inner);
  const cell = `${F}font-size:15px;line-height:1.7;letter-spacing:0.02em;color:${C.ink};`;
  if (!kv) {
    return `<tr><td colspan="2" style="padding:12px 0;${line}${cell}">${child.inner}</td></tr>`;
  }
  const key = kv[1]!.trim();
  const value = kv[2]!.replace(/^(?:\s|&nbsp;|　|[:：])+/, '');
  return `<tr><td class="nk-key" valign="top" width="72" style="width:72px;padding:12px 12px 12px 0;${line}${F}font-size:13px;line-height:1.95;font-weight:700;letter-spacing:0.12em;color:${tone.accent};white-space:nowrap;">${key}</td><td valign="top" style="padding:12px 0;${line}${cell}">${value}</td></tr>`;
}

function panelBlock(inner: string, tone: ReturnType<typeof toneOf>): string {
  const rows = blockChildren(inner)
    .filter((child) => child.tag === 'p' || /^h[1-6]$/.test(child.tag))
    .map((child, index) => panelRow(child, tone, index === 0));
  return `<table class="nk-panel nk-tone-${tone.name}" ${TABLE} style="width:100%;margin:32px 0 32px 0;background:${tone.tint};border-radius:10px;border-collapse:separate;"><tr><td style="padding:10px 26px;"><table ${TABLE} style="width:100%;">${rows.join('')}</table></td></tr></table>`;
}

function cardBlock(inner: string, tone: ReturnType<typeof toneOf>): string {
  const children = blockChildren(inner);
  const thumbAt = children.findIndex((child) => asImage(child) !== null);
  const thumb = thumbAt >= 0 ? asImage(children[thumbAt]!) : null;
  const rest = children.filter((_child, index) => index !== thumbAt);
  const body = rest
    .map((child, index) => {
      const last = index === rest.length - 1;
      const bottom = last ? 0 : /^h[1-6]$/.test(child.tag) ? 6 : 10;
      if (/^h[1-6]$/.test(child.tag)) {
        return `<p class="nk-card-title" style="margin:0 0 ${bottom}px 0;${F}font-size:17px;line-height:1.5;font-weight:700;letter-spacing:0.02em;color:${C.ink};">${child.inner}</p>`;
      }
      if (child.tag === 'p') {
        return `<p style="margin:0 0 ${bottom}px 0;${F}font-size:15px;line-height:1.7;letter-spacing:0.02em;color:${C.soft};">${tintLinks(child.inner, tone.accent)}</p>`;
      }
      return child.outer;
    })
    .join('');
  const thumbCell = thumb
    ? `<td class="nk-box-thumb" valign="top" width="${EMAIL_CARD_THUMB + 20}" style="width:${EMAIL_CARD_THUMB + 20}px;padding:20px 0 20px 20px;">${setImgWidth(
        applyImgStyle(
          thumb,
          `width:${EMAIL_CARD_THUMB}px;max-width:100%;height:auto;display:block;border:0;border-radius:6px;margin:0;`,
        ),
        EMAIL_CARD_THUMB,
      )}</td>`
    : '';
  return `<table class="nk-box nk-tone-${tone.name}" ${TABLE} style="width:100%;margin:28px 0 28px 0;background:${C.card};border:1px solid ${tone.rule};border-top:3px solid ${tone.accent};border-radius:10px;border-collapse:separate;"><tr>${thumbCell}<td class="nk-box-body" valign="middle" style="padding:20px 22px 20px 20px;">${body}</td></tr></table>`;
}

function pullBlock(inner: string, tone: ReturnType<typeof toneOf>): string {
  const lines = blockChildren(inner)
    .filter((child) => child.tag === 'p' || /^h[1-6]$/.test(child.tag))
    .map(
      (child, index, all) =>
        `<p style="margin:0 0 ${index === all.length - 1 ? 0 : 10}px 0;${F}font-size:21px;line-height:1.7;font-weight:600;letter-spacing:0.03em;color:${C.ink};text-align:center;">${child.inner}</p>`,
    )
    .join('');
  const bar = `<table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto 18px;"><tr><td class="nk-bar" width="28" height="2" style="width:28px;height:2px;font-size:0;line-height:0;background:${tone.accent};">&nbsp;</td></tr></table>`;
  return `<table class="nk-pull nk-tone-${tone.name}" ${TABLE} style="width:100%;margin:40px 0 40px 0;"><tr><td style="padding:8px 12px 8px 12px;">${bar}${lines}</td></tr></table>`;
}

function stepsBlock(inner: string, tone: ReturnType<typeof toneOf>): string {
  const items = [...inner.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map((match) => match[1] ?? '');
  const rows = items.map((item, index) => {
    const parts = blockChildren(item);
    const text = (parts.length ? parts : [{ tag: 'p', attrs: '', inner: item, outer: item }])
      .map((child, at, all) => {
        const bottom = at === all.length - 1 ? 0 : 4;
        const look =
          at === 0
            ? `font-size:16px;line-height:1.7;color:${C.ink};`
            : `font-size:15px;line-height:1.75;color:${C.soft};`;
        return `<p style="margin:0 0 ${bottom}px 0;${F}${look}letter-spacing:0.02em;">${child.inner}</p>`;
      })
      .join('');
    const pad = index === items.length - 1 ? 0 : 20;
    return `<tr><td valign="top" width="48" style="width:48px;padding:0 0 ${pad}px 0;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td class="nk-step" align="center" valign="middle" width="30" height="30" style="width:30px;height:30px;border-radius:15px;background:${tone.tint};${F}font-size:13px;line-height:30px;font-weight:700;color:${tone.accent};text-align:center;">${index + 1}</td></tr></table></td><td valign="top" style="padding:2px 0 ${pad}px 0;">${text}</td></tr>`;
  });
  return `<table class="nk-steps nk-tone-${tone.name}" ${TABLE} style="width:100%;margin:8px 0 28px 0;">${rows.join('')}</table>`;
}

/** 重點清單：標題（引言裡的標題）加一列列打勾的項目。項目可以是清單項目或段落。 */
function recapBlock(inner: string, tone: ReturnType<typeof toneOf>): string {
  const children = blockChildren(inner);
  const titleChild = children.find((child) => /^h[1-6]$/.test(child.tag));
  const items: string[] = [];
  for (const child of children) {
    if (child === titleChild) continue;
    if (child.tag === 'ul' || child.tag === 'ol') {
      for (const li of child.inner.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
        items.push((li[1] ?? '').replace(/<\/?p\b[^>]*>/gi, ' ').trim());
      }
    } else if (child.tag === 'p' && child.inner.trim()) {
      items.push(child.inner);
    }
  }
  const title = titleChild
    ? `<p class="nk-recap-title" style="margin:0 0 12px 0;${F}font-size:13px;line-height:1.6;font-weight:700;letter-spacing:0.16em;color:${tone.accent};">${titleChild.inner}</p>`
    : '';
  const rows = items
    .map((item, index) => {
      const pad = index === items.length - 1 ? 0 : 10;
      return `<tr><td class="nk-check" valign="top" width="24" style="width:24px;padding:0 0 ${pad}px 0;${F}font-size:14px;line-height:1.75;font-weight:700;color:${tone.accent};">✓</td><td valign="top" style="padding:0 0 ${pad}px 0;${F}font-size:15px;line-height:1.75;letter-spacing:0.02em;color:${C.ink};">${tintLinks(item, tone.accent)}</td></tr>`;
    })
    .join('');
  return `<table class="nk-recap nk-tone-${tone.name}" ${TABLE} style="width:100%;margin:32px 0 32px 0;background:${tone.tint};border-radius:10px;border-collapse:separate;"><tr><td class="nk-recap-cell" style="padding:22px 26px 22px 24px;">${title}<table ${TABLE} style="width:100%;">${rows}</table></td></tr></table>`;
}

const STEP_HEADING_SIZE: Record<string, number> = { h1: 24, h2: 21, h3: 18, h4: 16, h5: 15, h6: 14 };

/** 步驟標題：左邊編號圓章、右邊標題。編號依信裡出現的順序自動算，使用者不用自己打。 */
function styleStepHeadings(html: string): string {
  let count = 0;
  return html.replace(
    /<(h[1-6])\b([^>]*\sdata-email-style="step"[^>]*)>([\s\S]*?)<\/\1>/gi,
    (_match, rawTag: string, attrs: string, inner: string) => {
      count += 1;
      const tag = rawTag.toLowerCase();
      const tone = toneOf(attrs);
      const size = STEP_HEADING_SIZE[tag] ?? 21;
      const badge = `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td class="nk-step" align="center" valign="middle" width="32" height="32" style="width:32px;height:32px;border-radius:16px;background:${tone.accent};${F}font-size:14px;line-height:32px;font-weight:700;color:#ffffff;text-align:center;">${count}</td></tr></table>`;
      return `<table class="nk-stephead nk-tone-${tone.name}" ${TABLE} style="width:100%;margin:44px 0 14px 0;"><tr><td valign="middle" width="46" style="width:46px;padding:0;">${badge}</td><td valign="middle" style="padding:0;"><${tag} style="margin:0;font-family:${EMAIL_FONT};color:${C.ink};font-size:${size}px;line-height:1.45;font-weight:700;letter-spacing:0.02em;">${inner}</${tag}></td></tr></table>`;
    },
  );
}

const BLOCKQUOTE_RENDER: Record<string, (inner: string, tone: ReturnType<typeof toneOf>) => string> = {
  panel: panelBlock,
  card: cardBlock,
  pull: pullBlock,
  recap: recapBlock,
};

/** 把帶 data-email-style 的區塊換成信箱吃得下的 markup。其他內容原樣留著。 */
export function styleEmailBlocks(html: string): string {
  return styleParagraphs(
    styleStepHeadings(html)
      .replace(
        /<blockquote\b([^>]*\sdata-email-style="([a-z]+)"[^>]*)>([\s\S]*?)<\/blockquote>/gi,
        (match, attrs: string, kind: string, inner: string) => {
          const render = BLOCKQUOTE_RENDER[kind];
          return render ? render(inner, toneOf(attrs)) : match;
        },
      )
      .replace(
        /<ol\b([^>]*\sdata-email-style="steps"[^>]*)>([\s\S]*?)<\/ol>/gi,
        (_match, attrs: string, inner: string) => stepsBlock(inner, toneOf(attrs)),
      )
      .replace(/<hr\b([^>]*\sdata-email-style="ornament"[^>]*)\/?>/gi, (_match, attrs: string) => {
        const tone = toneOf(attrs, 'ink');
        return `<p class="nk-orn nk-tone-${tone.name}" style="margin:44px 0 44px 0;${F}font-size:14px;line-height:1;letter-spacing:0.9em;text-indent:0.9em;text-align:center;color:${tone.accent};">···</p>`;
      }),
  );
}

/** 標籤底下緊接的標題不再留上外距，兩者讀起來是一組。 */
export function tightenAfterKicker(html: string): string {
  return html.replace(
    /(<p class="nk-kicker[^"]*"[^>]*>[\s\S]*?<\/p>\s*)(<h[1-6]\b[^>]*>)/gi,
    (_match, kicker: string, heading: string) => `${kicker}${zeroMargin(heading, 'top')}`,
  );
}

/** 只在支援 <style> 的信箱生效：深色模式換點綴色、手機版縮圖縮小。 */
export function emailBlockHeadStyle(): string {
  const tones = EMAIL_TONE_NAMES.map((name) => {
    const t = EMAIL_TONES[name];
    return [
      `.nk-card .nk-tone-${name}.nk-kicker,.nk-card .nk-tone-${name} .nk-key,.nk-card .nk-tone-${name} .nk-step,.nk-card .nk-tone-${name}.nk-orn,.nk-card .nk-tone-${name} .nk-check,.nk-card .nk-tone-${name} .nk-recap-title,.nk-card .nk-tone-${name} a{color:${t.darkAccent} !important;}`,
      `.nk-card .nk-tone-${name} .nk-step,.nk-card table.nk-panel.nk-tone-${name},.nk-card table.nk-recap.nk-tone-${name},.nk-card .nk-tone-${name} .nk-tip-cell{background:${t.darkTint} !important;}`,
      `.nk-card .nk-stephead.nk-tone-${name} .nk-step{background:${t.darkAccent} !important;color:#161513 !important;}`,
      `.nk-card .nk-tone-${name} .nk-tip-cell{border-left-color:${t.darkAccent} !important;}`,
      `.nk-card .nk-tone-${name} .nk-bar{background:${t.darkAccent} !important;}`,
      `.nk-card table.nk-box.nk-tone-${name}{border-top-color:${t.darkAccent} !important;}`,
    ].join('\n  ');
  }).join('\n  ');
  return `@media screen and (max-width:640px){
  .nk-box-thumb{width:96px !important;padding:16px 0 16px 16px !important;}
  .nk-box-thumb img{width:96px !important;}
  .nk-box-body{padding:16px 16px 16px 14px !important;}
  .nk-panel > tbody > tr > td,.nk-panel > tr > td{padding:6px 20px !important;}
  .nk-recap-cell{padding:18px 20px !important;}
}
@media (prefers-color-scheme:dark){
  .nk-card table.nk-box{background:#1f1d1b !important;border-color:#38342f !important;}
  .nk-card .nk-panel td,.nk-card .nk-meta{border-color:#38342f !important;}
  .nk-card .nk-note,.nk-card .nk-meta,.nk-card .nk-tip-cell{color:#a39b90 !important;}
  .nk-card .nk-lead,.nk-card .nk-card-title,.nk-card .nk-pull p{color:#f6f2ec !important;}
  ${tones}
}`;
}

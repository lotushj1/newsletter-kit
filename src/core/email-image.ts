export function emailHero(src: string, alt: string): string {
  return `<img data-email-hero="1" src="${src}" alt="${alt}" width="600" />`;
}

export function emailImageSlot(label = '建議置入圖片'): string {
  return `<figure data-email-image-slot="1" data-label="${label}">${label}</figure>`;
}

/** 內文圖片與非滿版首圖共用，不給使用者調。 */
export const EMAIL_IMAGE_RADIUS = 6;

/** 一般圖：對齊內文欄寬，上下留白比段落多一點。 */
export const EMAIL_IMAGE_STYLE =
  `width:100%;max-width:100%;height:auto;display:block;border:0;border-radius:${EMAIL_IMAGE_RADIUS}px;margin:28px auto;`;

/** 信中段的封面圖：滿欄、固定圓角。開頭那張會另外抽成滿版首圖。 */
export const EMAIL_HERO_STYLE =
  `width:100%;max-width:100%;height:auto;display:block;border:0;border-radius:${EMAIL_IMAGE_RADIUS}px;margin:28px auto;`;

/** 白卡片最上方的滿版首圖：貼齊卡片邊緣，圓角交給卡片 overflow。 */
export const EMAIL_COVER_STYLE =
  'width:100%;max-width:600px;height:auto;display:block;border:0;margin:0;';

/** 內文滿版圖與封面共用：貼齊白卡片左右邊緣。 */
export const EMAIL_FULLWIDTH_STYLE = EMAIL_COVER_STYLE;

const LEADING_IMG_RE =
  /^\s*(?:<p\b[^>]*>\s*(<img\b[^>]*>)\s*<\/p>|(<img\b[^>]*>))/i;

const BLEED_IMG_RE =
  /(?:<p\b[^>]*>\s*)?(<img\b[^>]*\bdata-email-fullwidth\s*=\s*["']?1["']?[^>]*>)\s*(?:<\/p>)?/gi;

export function isFullWidthImageTag(tag: string): boolean {
  return /data-email-fullwidth\s*=\s*["']?1["']?/i.test(tag);
}

export function isNormalWidthImageTag(tag: string): boolean {
  return /data-email-fullwidth\s*=\s*["']?0["']?/i.test(tag);
}

/** 開頭要抽成貼邊封面：明確滿版，或舊的 hero 且沒有指定一般寬度。 */
export function isCoverImageTag(tag: string): boolean {
  if (isNormalWidthImageTag(tag)) return false;
  return isFullWidthImageTag(tag) || /\bdata-email-hero\b/i.test(tag);
}

export function imageInlineStyle(tag: string): string {
  if (isFullWidthImageTag(tag)) return EMAIL_FULLWIDTH_STYLE;
  if (isNormalWidthImageTag(tag)) return EMAIL_IMAGE_STYLE;
  if (/\bdata-email-hero\b/i.test(tag)) return EMAIL_HERO_STYLE;
  return EMAIL_IMAGE_STYLE;
}

export function splitLeadingHero(html: string): { coverHtml: string | null; bodyHtml: string } {
  const match = LEADING_IMG_RE.exec(html);
  if (!match) return { coverHtml: null, bodyHtml: html };
  const tag = match[1] || match[2] || '';
  if (!tag || !isCoverImageTag(tag)) return { coverHtml: null, bodyHtml: html };
  return { coverHtml: tag, bodyHtml: html.slice(match[0].length) };
}

export type EmailBodySegment = { type: 'content' | 'bleed'; html: string };

export function splitBleedSegments(html: string): EmailBodySegment[] {
  const segments: EmailBodySegment[] = [];
  let last = 0;
  BLEED_IMG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = BLEED_IMG_RE.exec(html))) {
    const before = html.slice(last, match.index);
    if (before) segments.push({ type: 'content', html: before });
    segments.push({ type: 'bleed', html: match[1] ?? match[0] });
    last = match.index + match[0].length;
  }
  const rest = html.slice(last);
  if (rest) segments.push({ type: 'content', html: rest });
  return segments;
}

export function applyImgStyle(tag: string, style: string): string {
  if (/\sstyle="/i.test(tag)) return tag.replace(/\sstyle="[^"]*"/i, ` style="${style}"`);
  return tag.replace(/<img\b/i, `<img style="${style}"`);
}

/** Outlook 不吃 max-width，用 width 屬性把圖鎖在欄寬內。 */
export function setImgWidth(tag: string, width: number): string {
  if (/\swidth\s*=\s*["']?[^"'\s>]*["']?/i.test(tag)) {
    return tag.replace(/\swidth\s*=\s*["']?[^"'\s>]*["']?/i, ` width="${width}"`);
  }
  return tag.replace(/<img\b/i, `<img width="${width}"`);
}

/** 圖片空位的說明裡寫了「封面」或「滿版」，換成真圖時就貼齊白卡片左右邊。 */
export function isFullWidthSlotLabel(label: string): boolean {
  return /封面|滿版/.test(label);
}

/** 從「…｜建議 1200×630」讀出比例，讀不到就用 16:9。 */
export function slotRatio(label: string): number {
  const match = /(\d{2,4})\s*[×xX*]\s*(\d{2,4})/.exec(label);
  if (!match) return 9 / 16;
  const w = Number(match[1]);
  const h = Number(match[2]);
  return w > 0 && h > 0 ? h / w : 9 / 16;
}

const svgEscape = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * 預覽用的中性占位圖（SVG data URI），把說明與建議尺寸畫在圖上。
 * 只給模板縮圖與預覽用；寄出的信一律把空位拿掉。
 */
export function placeholderImageSrc(label: string, width: number): string {
  const height = Math.round(width * slotRatio(label));
  const [main = label, hint = ''] = label.split('｜');
  const compact = width < 240;
  const cx = width / 2;
  const icon = compact ? 0.8 : 1;
  const iconY = compact ? height / 2 - 16 : height / 2 - 30;
  const font = "-apple-system,'PingFang TC','Noto Sans TC','Microsoft JhengHei',sans-serif";
  const text = compact
    ? `<text x="${cx}" y="${height / 2 + 26}" text-anchor="middle" font-family="${font}" font-size="11" fill="#8a8277">${svgEscape(hint.replace(/^建議\s*/, '') || '圖片')}</text>`
    : `<text x="${cx}" y="${height / 2 + 22}" text-anchor="middle" font-family="${font}" font-size="14" font-weight="600" fill="#6f675d" letter-spacing="0.5">${svgEscape(main)}</text>` +
      (hint
        ? `<text x="${cx}" y="${height / 2 + 44}" text-anchor="middle" font-family="${font}" font-size="12" fill="#968e83" letter-spacing="0.5">${svgEscape(hint)}</text>`
        : '');
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect width="${width}" height="${height}" fill="#ebe7e0"/>` +
    `<g transform="translate(${cx} ${iconY}) scale(${icon})" fill="none" stroke="#a69e93" stroke-width="1.6" stroke-linejoin="round">` +
    `<rect x="-18" y="-14" width="36" height="28" rx="4"/><circle cx="-7" cy="-5" r="3"/><path d="M-18 10 L-5 -1 L4 7 L10 2 L18 9"/></g>` +
    text +
    `</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const SLOT_RE = /<figure\b([^>]*data-email-image-slot[^>]*)>[\s\S]*?<\/figure>/gi;

function slotLabel(attrs: string): string {
  const match = /\sdata-label="([^"]*)"/i.exec(attrs);
  return (match?.[1] ?? '').trim() || '建議置入圖片';
}

/** 把還沒放圖的空位換成占位圖：封面／滿版貼邊、卡片裡當縮圖、其餘對齊內文欄。 */
export function fillImageSlotPlaceholders(html: string, textWidth: number, cardWidth: number, thumbWidth: number): string {
  const toImg = (attrs: string, width: number, layout: 'full' | 'normal'): string => {
    const label = slotLabel(attrs);
    const flags = layout === 'full' ? 'data-email-hero="1" data-email-fullwidth="1"' : 'data-email-fullwidth="0"';
    return `<img data-email-placeholder="1" ${flags} src="${placeholderImageSrc(label, width)}" alt="${label}" width="${width}" />`;
  };
  const inCards = html.replace(
    /(<blockquote\b[^>]*data-email-style="card"[^>]*>)([\s\S]*?)(<\/blockquote>)/gi,
    (_m, open: string, inner: string, close: string) =>
      `${open}${inner.replace(SLOT_RE, (_s, attrs: string) => toImg(attrs, thumbWidth, 'normal'))}${close}`,
  );
  return inCards.replace(SLOT_RE, (_s, attrs: string) =>
    isFullWidthSlotLabel(slotLabel(attrs)) ? toImg(attrs, cardWidth, 'full') : toImg(attrs, textWidth, 'normal'),
  );
}

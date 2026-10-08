/** Unsplash 來源圖裁成固定比例，當裝飾用。 */
export function unsplashCrop(photoId: string, width = 1200, height = 300): string {
  return `https://images.unsplash.com/${photoId}?auto=format&fit=crop&w=${width}&h=${height}&q=80`;
}

export function emailHero(src: string, alt: string): string {
  return `<img data-email-hero="1" src="${src}" alt="${alt}" width="600" />`;
}

export function emailImageSlot(label = '建議置入圖片'): string {
  return `<figure data-email-image-slot="1" data-label="${label}">${label}</figure>`;
}

/** 內文圖片與非滿版首圖共用，不給使用者調。 */
export const EMAIL_IMAGE_RADIUS = 10;

export const EMAIL_IMAGE_STYLE =
  `width:100%;max-width:420px;height:auto;display:block;border:0;border-radius:${EMAIL_IMAGE_RADIUS}px;margin:16px auto;`;

/** 信中段的封面圖：滿欄、固定圓角。開頭那張會另外抽成滿版首圖。 */
export const EMAIL_HERO_STYLE =
  `width:100%;max-width:100%;height:auto;display:block;border:0;border-radius:${EMAIL_IMAGE_RADIUS}px;margin:16px auto;`;

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

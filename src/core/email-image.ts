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

const LEADING_HERO_RE =
  /^\s*(?:<p\b[^>]*>\s*(<img\b[^>]*\bdata-email-hero\b[^>]*>)\s*<\/p>|(<img\b[^>]*\bdata-email-hero\b[^>]*>))/i;

export function splitLeadingHero(html: string): { coverHtml: string | null; bodyHtml: string } {
  const match = LEADING_HERO_RE.exec(html);
  if (!match) return { coverHtml: null, bodyHtml: html };
  return { coverHtml: match[1] || match[2] || null, bodyHtml: html.slice(match[0].length) };
}

export function applyImgStyle(tag: string, style: string): string {
  if (/\sstyle="/i.test(tag)) return tag.replace(/\sstyle="[^"]*"/i, ` style="${style}"`);
  return tag.replace(/<img\b/i, `<img style="${style}"`);
}

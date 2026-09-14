export function emailHero(src: string, alt: string): string {
  return `<img data-email-hero="1" src="${src}" alt="${alt}" width="1200" />`;
}

export function emailImageSlot(label = '建議置入圖片'): string {
  return `<figure data-email-image-slot="1" data-label="${label}">${label}</figure>`;
}

export const EMAIL_IMAGE_STYLE =
  'width:100%;max-width:100%;height:auto;display:block;border:0;border-radius:12px;margin:16px 0;';
export const EMAIL_HERO_STYLE =
  'width:100%;max-width:100%;height:auto;display:block;border:0;margin:0 0 20px;';

/** Unsplash 來源圖裁成橫幅，當裝飾用，不要讓信裡出現很高的圖。 */
export function unsplashCrop(photoId: string, width = 1200, height = 300): string {
  return `https://images.unsplash.com/${photoId}?auto=format&fit=crop&w=${width}&h=${height}&q=80`;
}

export function emailHero(src: string, alt: string): string {
  return `<img data-email-hero="1" src="${src}" alt="${alt}" width="420" />`;
}

export function emailImageSlot(label = '建議置入圖片'): string {
  return `<figure data-email-image-slot="1" data-label="${label}">${label}</figure>`;
}

export const EMAIL_IMAGE_STYLE =
  'width:100%;max-width:420px;height:auto;display:block;border:0;border-radius:10px;margin:16px auto;';
export const EMAIL_HERO_STYLE =
  'width:100%;max-width:420px;height:auto;display:block;border:0;border-radius:10px;margin:0 auto 20px;';

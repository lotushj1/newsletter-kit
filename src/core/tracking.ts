import { createTrackingToken } from './tokens.js';

/**
 * href 屬性值是 HTML，查詢字串裡的 & 會被寫成 &amp;。簽名與轉址要用解碼後的真正網址，
 * 否則 ?a=1&amp;utm_source=x 會讓 utm 參數變成「amp;utm_source」。
 * 舊信件裡已簽名的網址也走這裡，所以已寄出的信再點也會導到正確網址。
 */
function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;|&#0*38;|&#x0*26;/gi, '&')
    .replace(/&quot;|&#0*34;|&#x0*22;/gi, '"')
    .replace(/&#0*39;|&#x0*27;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

export function normalizeTrackedUrl(url: string): string {
  const decoded = decodeHtmlEntities(url.trim());
  try { return new URL(decoded).toString(); } catch { return decoded; }
}

export interface TrackingInjectInput {
  secret: string;
  publicBaseUrl: string;
  email: string;
  campaignId: string;
  deliveryId: string;
  subscriberId: string;
}

function shouldSkipUrl(url: string, publicBaseUrl: string): boolean {
  try {
    const parsed = new URL(url);
    const self = new URL(publicBaseUrl);
    if (parsed.origin !== self.origin) return false;
    const path = parsed.pathname;
    return (
      path.startsWith('/unsubscribe') ||
      path.startsWith('/confirm') ||
      path.startsWith('/t/')
    );
  } catch {
    return true;
  }
}

/**
 * 正式寄送才呼叫。把 http(s) 連結改成簽名轉址，並在 </body> 前塞 1×1 pixel。
 * 測試信、預覽、封存不要走這條。
 */
export function injectTracking(html: string, input: TrackingInjectInput): string {
  const rewritten = html.replace(/href=(["'])(https?:\/\/[^"']+)\1/gi, (match, quote: string, url: string) => {
    if (shouldSkipUrl(url, input.publicBaseUrl)) return match;
    const token = createTrackingToken(input.secret, {
      purpose: 'click',
      email: input.email,
      campaignId: input.campaignId,
      deliveryId: input.deliveryId,
      subscriberId: input.subscriberId,
      url: normalizeTrackedUrl(url),
    });
    return `href=${quote}${input.publicBaseUrl}/t/click?token=${encodeURIComponent(token)}${quote}`;
  });

  const openToken = createTrackingToken(input.secret, {
    purpose: 'open',
    email: input.email,
    campaignId: input.campaignId,
    deliveryId: input.deliveryId,
    subscriberId: input.subscriberId,
  });
  const pixel = `<img src="${input.publicBaseUrl}/t/open?token=${encodeURIComponent(openToken)}" width="1" height="1" alt="" style="display:none;width:1px;height:1px;border:0;" />`;
  if (/<\/body>/i.test(rewritten)) return rewritten.replace(/<\/body>/i, `${pixel}</body>`);
  return rewritten + pixel;
}

/** 1×1 透明 GIF，給開信 pixel 用。 */
export const TRANSPARENT_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
);

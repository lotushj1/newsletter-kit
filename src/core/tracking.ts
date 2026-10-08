import { createTrackingToken } from './tokens.js';

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
      url,
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

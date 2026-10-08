import { escapeHtml } from './render.js';

/** double opt-in 確認信的內文：一句說明、一個確認按鈕，按鈕失效時還有網址可貼。 */
export function confirmEmailContentHtml(siteName: string, link: string): string {
  const site = escapeHtml(siteName);
  const href = escapeHtml(link);
  // 按鈕的網址在套版時才 escape，這裡只防引號。
  return [
    '<p data-email-style="kicker" data-email-tone="clay">訂閱確認</p>',
    '<h1>再一步就完成訂閱</h1>',
    `<p>請按下面的按鈕，確認你要收到 ${site} 的電子報。確認之後，電子報就會寄到這個信箱。</p>`,
    `<div data-email-btn data-href="${link.replace(/"/g, '%22')}" data-label="確認訂閱" data-bg="#1c1917" data-border="0" data-border-color="#1c1917" data-radius="8">確認訂閱</div>`,
    `<p data-email-style="note">按鈕沒有反應的話，把這個網址貼到瀏覽器：<br><a href="${href}">${href}</a></p>`,
    '<hr>',
    '<p data-email-style="note">如果這不是你本人操作，直接忽略這封信就好，我們不會把你加進名單。</p>',
  ].join('');
}

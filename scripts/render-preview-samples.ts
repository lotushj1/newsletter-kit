/**
 * 用真正的 renderEmailLayout 產出一封示範電子報與公開封存頁，給改版型時目檢用。
 *
 *   npx tsx scripts/render-preview-samples.ts [輸出資料夾]
 *
 * 預設輸出到 ../newsletter-kit-previews/（repo 外）。圖片用 picsum，需要連網才看得到。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { attachBrandSignature, buildBrandSignatureHtml } from '../src/core/brand-signature.js';
import { applyVariables, renderEmailLayout } from '../src/core/render.js';
import { sigIconBuffer } from '../src/core/sig-icons.js';
import { archiveItemPage } from '../src/http/views/pages.js';
import { EMPTY_BRAND, SIGNATURE_LINK_ICONS, type BrandProfile, type Campaign } from '../src/store/types.js';

const outDir = resolve(process.argv[2] ?? resolve(import.meta.dirname, '../../newsletter-kit-previews'));
mkdirSync(resolve(outDir, 'sig-icons'), { recursive: true });
for (const icon of SIGNATURE_LINK_ICONS) {
  const png = sigIconBuffer(icon);
  if (png) writeFileSync(resolve(outDir, 'sig-icons', `${icon}.png`), png);
}
const publicBaseUrl = pathToFileURL(outDir).href;

const siteName = '凱文設計 Kevin Design';
const brand: BrandProfile = {
  ...EMPTY_BRAND,
  writerName: '凱文 Kevin',
  title: '視覺設計師',
  organization: '凱文設計 Kevin Design',
  tagline: '把複雜的事，排成一眼看懂的樣子。',
  avatarUrl: 'https://picsum.photos/seed/kd-avatar/160/160',
  signatureLayout: 'avatar-left',
  signatureLinks: [
    { id: 'w', icon: 'website', url: 'https://creatorhome.tw' },
    { id: 'i', icon: 'instagram', url: 'https://instagram.com/kevin' },
    { id: 't', icon: 'threads', url: 'https://threads.net/@kevin' },
    { id: 'y', icon: 'youtube', url: 'https://youtube.com/@kevin' },
  ],
};

const body = [
  '<img data-email-fullwidth="1" src="https://picsum.photos/seed/kd1/1200/700" alt="工作室桌面" />',
  '<h1>留白不是空著，是讓重點有地方站</h1>',
  '<p>嗨 {{name}}，</p>',
  '<p>這週替一個品牌改版官網，客戶第一句話是：「可以再塞多一點東西嗎？」我很能理解這種焦慮——每個區塊都想被看見。但版面就像一間房間，家具越多，越難找到門。</p>',
  '<h2>一、先決定讀者第一眼要看到什麼</h2>',
  '<p>排版之前，我會先寫一句話：<strong>這一頁只要讀者記得一件事，是什麼？</strong>寫不出來，代表內容還沒想清楚，不是版面的問題。</p>',
  '<img data-email-fullwidth="0" src="https://picsum.photos/seed/kd2/1040/640" alt="草稿與色票" />',
  '<p>上面是這次的草稿。左邊是客戶原本的版本，右邊是拿掉一半元素之後——資訊沒有變少，只是排出了先後。</p>',
  '<h3>我常用的三個檢查</h3>',
  '<ul><li><p>標題和內文的字級差距，至少要 1.5 倍</p></li><li><p>同一層級的間距只用一種數字</p></li><li><p>每個區塊只留一個主要動作</p></li></ul>',
  '<blockquote><p>好的設計不是再也沒有東西可以加，而是再也沒有東西可以拿掉。</p></blockquote>',
  '<img data-email-fullwidth="1" src="https://picsum.photos/seed/kd3/1200/600" alt="展覽現場" />',
  '<h2>二、把留白當成材料</h2>',
  '<p>留白有自己的節奏。下面是我改稿時的順序，你可以拿手邊的作品試試看：</p>',
  '<ol><li><p>先把所有間距統一成 8 的倍數</p></li><li><p>標題上方的距離，放大到標題下方的兩倍</p></li><li><p>最後才調整顏色與字重</p></li></ol>',
  '<p>完整的改版前後對照，我整理在 <a href="https://creatorhome.tw">創作邦的這篇文章</a>，也附上可以直接套用的 <code>8pt</code> 間距表。</p>',
  '<div data-email-btn data-href="https://creatorhome.tw" data-bg="#1c1917" data-border="0" data-border-color="#1c1917" data-radius="6">看完整改版對照</div>',
  '<hr>',
  '<p>下週想聊「字體配對」。如果你有一直搞不定的中英混排，直接回這封信告訴我。</p>',
  '<p>下週見，</p>',
  '{{signature}}',
].join('');

const variables = { name: '朋友', site_name: siteName, unsubscribe_url: '#', writer: brand.writerName, website: '' };
const signature = applyVariables(buildBrandSignatureHtml(brand, { publicBaseUrl }), variables, 'html');
const contentHtml = attachBrandSignature(
  applyVariables(body, { ...variables, signature }, 'html', { raw: ['signature'] }),
  signature,
);

const subject = '留白不是空著，是讓重點有地方站';
const email = renderEmailLayout({
  subject,
  preheader: '這週改版官網時想到的三件事，和一張可以直接套用的間距表',
  contentHtml,
  siteName,
  publicBaseUrl,
  unsubscribeUrl: 'https://news.creatorhome.tw/unsubscribe?token=sample',
  webViewUrl: 'https://news.creatorhome.tw/archive/whitespace',
  footerNote: '你會收到這封信，是因為你訂閱了凱文設計的電子報。',
});
writeFileSync(resolve(outDir, 'email.html'), email);

const archiveHtml = renderEmailLayout({ subject, contentHtml, siteName, publicBaseUrl });
const campaign = { title: subject, slug: 'whitespace', sentAt: '2026-10-08T02:00:00.000Z' } as Campaign;
writeFileSync(resolve(outDir, 'archive.html'), archiveItemPage(siteName, campaign, subject, archiveHtml));

console.log(`寫入 ${outDir}/email.html、archive.html`);

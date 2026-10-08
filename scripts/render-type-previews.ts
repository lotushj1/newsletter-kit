/**
 * 每種內建模板（加空白模板與訂閱確認信）各產一份預覽 HTML，再用無頭 Chrome 截桌機與手機兩張圖。
 * 走的是後台模板縮圖同一條路（renderPreviewEmail，空位畫成占位圖）。
 *
 *   npx tsx scripts/render-type-previews.ts [輸出資料夾]
 *
 * 預設輸出到 ../newsletter-kit-previews/types/（repo 外）。簽名頭像用 picsum，需要連網才看得到。
 * 加 --no-shot 只產 HTML 不截圖。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BUILTIN_CAMPAIGN_STARTERS, EMPTY_STARTER_BODY } from '../src/core/campaign-starters.js';
import { renderPreviewEmail } from '../src/core/preview-email.js';
import { renderEmailLayout } from '../src/core/render.js';
import { sigIconBuffer } from '../src/core/sig-icons.js';
import { confirmEmailContentHtml } from '../src/core/system-emails.js';
import { EMPTY_BRAND, SIGNATURE_LINK_ICONS, type BrandProfile } from '../src/store/types.js';

const args = process.argv.slice(2);
const shoot = !args.includes('--no-shot');
const outDir = resolve(
  args.find((arg) => !arg.startsWith('--')) ?? resolve(import.meta.dirname, '../../newsletter-kit-previews/types'),
);
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
  ],
};

const pages: { type: string; html: string }[] = [
  ...BUILTIN_CAMPAIGN_STARTERS.map((starter) => ({
    type: starter.id,
    html: renderPreviewEmail({
      bodyHtml: starter.bodyHtml,
      subject: starter.title,
      preheader: starter.preheader,
      siteName,
      publicBaseUrl,
      brand,
      imageSlots: 'placeholder',
    }).html,
  })),
  {
    type: 'blank',
    html: renderPreviewEmail({ bodyHtml: EMPTY_STARTER_BODY, siteName, publicBaseUrl, brand, imageSlots: 'placeholder' })
      .html,
  },
  {
    // 跟 sendConfirmEmail 同樣的參數。
    type: 'confirm',
    html: renderEmailLayout({
      subject: `確認訂閱 ${siteName}`,
      preheader: '點一下連結就完成訂閱',
      contentHtml: confirmEmailContentHtml(siteName, 'https://news.example.com/confirm?token=sample-token'),
      siteName,
      footerNote: '這封信是因為有人用這個地址申請訂閱才寄出的。',
    }),
  },
];

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function chrome(extra: string[]): string {
  const result = spawnSync(
    CHROME,
    ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--virtual-time-budget=4000', ...extra],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return result.stdout ?? '';
}

/** 無頭 Chrome 的視窗窄不到 390px，手機版放進 390px 寬的 iframe，高度跟著內容撐開。 */
function mobileFrame(html: string): string {
  const doc = html.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#f3f1ec;}iframe{display:block;width:390px;border:0;}</style></head><body><iframe id="f" srcdoc="${doc}"></iframe><script>const f=document.getElementById('f');const fit=()=>{const h=f.contentDocument.documentElement.scrollHeight;f.style.height=h+'px';document.body.setAttribute('data-h',String(h));};f.addEventListener('load',fit);</script></body></html>`;
}

/** 把頁面高度寫進 DOM 再 dump 出來，截圖就不會多一大段空白。 */
function measure(file: string, width: number): number {
  const dom = chrome([`--window-size=${width},200`, '--dump-dom', pathToFileURL(file).href]);
  const height = Number(/data-h="(\d+)"/.exec(dom)?.[1] ?? '0');
  return height > 0 ? height : 3200;
}

const HEIGHT_PROBE = `<script>addEventListener('load',()=>{document.body.setAttribute('data-h',String(document.documentElement.scrollHeight));});</script>`;

for (const page of pages) {
  const file = resolve(outDir, `${page.type}.html`);
  writeFileSync(file, page.html);
  const mobile = resolve(outDir, `${page.type}-mobile.html`);
  writeFileSync(mobile, mobileFrame(page.html));
  if (!shoot || !existsSync(CHROME)) continue;
  const probe = resolve(outDir, `${page.type}.probe.html`);
  writeFileSync(probe, page.html.replace('</body>', `${HEIGHT_PROBE}</body>`));
  const desktopHeight = measure(probe, 760);
  rmSync(probe);
  chrome(['--window-size=760,' + desktopHeight, `--screenshot=${resolve(outDir, `${page.type}-desktop.png`)}`, pathToFileURL(file).href]);
  const mobileHeight = measure(mobile, 390);
  chrome(['--window-size=390,' + mobileHeight, `--screenshot=${resolve(outDir, `${page.type}-mobile.png`)}`, pathToFileURL(mobile).href]);
}

console.log(`寫入 ${outDir}/：${pages.map((page) => page.type).join('、')}`);

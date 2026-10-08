/**
 * 組出版面區塊的 HTML。內建模板與編輯器的 / 選單共用這一份，
 * 存進資料庫的就是這些節點加 data-email-style／data-email-tone（見 email-blocks.ts）。
 */
import type { EmailTone } from './email-theme.js';
import { emailImageSlot } from './email-image.js';

const toneAttr = (tone?: EmailTone) => (tone ? ` data-email-tone="${tone}"` : '');

export const kicker = (text: string, tone?: EmailTone) => `<p data-email-style="kicker"${toneAttr(tone)}>${text}</p>`;
export const lead = (text: string) => `<p data-email-style="lead">${text}</p>`;
export const note = (text: string) => `<p data-email-style="note">${text}</p>`;
export const meta = (text: string, tone?: EmailTone) => `<p data-email-style="meta"${toneAttr(tone)}>${text}</p>`;
export const tip = (text: string, tone?: EmailTone) => `<p data-email-style="tip"${toneAttr(tone)}>${text}</p>`;

/** 步驟標題：寄出時左邊會加上自動編號的圓章。 */
export const stepHeading = (text: string, tone?: EmailTone, level = 2) =>
  `<h${level} data-email-style="step"${toneAttr(tone)}>${text}</h${level}>`;

/** 資訊面板：每列「粗體欄位名＋內容」。 */
export const panel = (rows: [string, string][], tone?: EmailTone) =>
  `<blockquote data-email-style="panel"${toneAttr(tone)}>${rows
    .map(([key, value]) => `<p><strong>${key}</strong>　${value}</p>`)
    .join('')}</blockquote>`;

export const card = (parts: string[], tone?: EmailTone) =>
  `<blockquote data-email-style="card"${toneAttr(tone)}>${parts.join('')}</blockquote>`;

export const pull = (text: string, tone?: EmailTone) =>
  `<blockquote data-email-style="pull"${toneAttr(tone)}><p>${text}</p></blockquote>`;

/** 重點清單：一個小標題加幾個打勾的項目。 */
export const recap = (title: string, items: string[], tone?: EmailTone) =>
  `<blockquote data-email-style="recap"${toneAttr(tone)}><h3>${title}</h3><ul>${items
    .map((item) => `<li><p>${item}</p></li>`)
    .join('')}</ul></blockquote>`;

/** 編號步驟：每項第一段是標題，第二段是說明。 */
export const steps = (items: [string, string][], tone?: EmailTone) =>
  `<ol data-email-style="steps"${toneAttr(tone)}>${items
    .map(([title, body]) => `<li><p><strong>${title}</strong></p><p>${body}</p></li>`)
    .join('')}</ol>`;

export const ornament = (tone?: EmailTone) => `<hr data-email-style="ornament"${toneAttr(tone)}>`;

export interface EmailBlockSnippet {
  id: string;
  label: string;
  aliases: string[];
  /** tone 不給時用中性的 ink。 */
  html: (tone?: EmailTone) => string;
}

/** 編輯器 / 選單可插入的版面區塊，內容都是〔〕占位，插入後直接改字。 */
export const EMAIL_BLOCK_SNIPPETS: EmailBlockSnippet[] = [
  { id: 'kicker', label: '小標', aliases: ['kicker', 'label', 'eyebrow', '標籤'], html: (t) => kicker('〔小標〕', t) },
  {
    id: 'lead',
    label: '導言',
    aliases: ['lead', 'intro'],
    html: () => lead('〔用一兩句話說明這封信要談什麼〕'),
  },
  {
    id: 'step',
    label: '步驟標題',
    aliases: ['step', 'stephead', '教學'],
    html: (t) => stepHeading('〔這一步要做什麼〕', t),
  },
  {
    id: 'steps',
    label: '步驟',
    aliases: ['steps', 'ol', 'howto'],
    html: (t) =>
      steps(
        [
          ['〔第一步〕', '〔一句話說明〕'],
          ['〔第二步〕', '〔一句話說明〕'],
          ['〔第三步〕', '〔一句話說明〕'],
        ],
        t,
      ),
  },
  {
    id: 'panel',
    label: '資訊面板',
    aliases: ['panel', 'info', 'table'],
    html: (t) =>
      panel(
        [
          ['日期', '〔　〕'],
          ['地點', '〔　〕'],
          ['費用', '〔　〕'],
        ],
        t,
      ),
  },
  {
    id: 'card',
    label: '推薦卡片',
    aliases: ['card', 'pick', 'recommend'],
    html: (t) =>
      card(
        [
          emailImageSlot('卡片縮圖｜建議 600×600'),
          '<h3>〔名稱〕</h3>',
          '<p>〔用兩三句話說它好在哪裡、適合誰〕</p>',
          '<p><a href="https://example.com">〔連結文字〕 →</a></p>',
        ],
        t,
      ),
  },
  {
    id: 'recap',
    label: '重點清單',
    aliases: ['recap', 'check', 'summary', '整理'],
    html: (t) => recap('〔重點整理〕', ['〔第一個重點〕', '〔第二個重點〕', '〔第三個重點〕'], t),
  },
  { id: 'tip', label: '提示框', aliases: ['tip', 'hint', 'callout'], html: (t) => tip('〔提示：補充一個容易忽略的細節〕', t) },
  {
    id: 'pull',
    label: '置中引言',
    aliases: ['pull', 'pullquote'],
    html: (t) => pull('〔想讓讀者記住的一句話〕', t),
  },
  {
    id: 'meta',
    label: '資訊行',
    aliases: ['meta', 'byline'],
    html: (t) => meta('〔欄位〕　〔內容〕　　〔欄位〕　〔內容〕', t),
  },
  { id: 'note', label: '附註', aliases: ['note', 'small', 'ps'], html: () => note('〔補充說明，例如截止日或注意事項〕') },
  { id: 'ornament', label: '··· 分隔', aliases: ['ornament', 'dots', 'divider'], html: (t) => ornament(t) },
];

import { marked } from 'marked';
import { emailButtonMarkup, normalizeEmailButtonStyle } from './email-button.js';
import { emailBlockHeadStyle, EMAIL_CARD_THUMB, styleEmailBlocks, tightenAfterKicker } from './email-blocks.js';
import {
  applyImgStyle,
  EMAIL_FULLWIDTH_STYLE,
  fillImageSlotPlaceholders,
  EMAIL_IMAGE_STYLE,
  imageInlineStyle,
  isFullWidthImageTag,
  setImgWidth,
  splitBleedSegments,
  splitLeadingHero,
} from './email-image.js';
import {
  EMAIL_BODY_LINE,
  EMAIL_BODY_SIZE,
  EMAIL_BODY_TRACKING,
  EMAIL_COLORS,
  EMAIL_FONT,
  styleTypography,
  trimEdgeMargins,
} from './email-theme.js';
import { DEFAULT_UNSUBSCRIBE_LABEL, DEFAULT_UNSUBSCRIBE_PROMPT } from '../store/types.js';

marked.setOptions({ gfm: true, breaks: true });

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function markdownToHtml(markdown: string): string {
  return marked.parse(markdown, { async: false });
}

/**
 * `{{name}}` 這類變數替換。HTML 欄位會做 escape，純文字欄位不會。
 * 找不到的變數會替換成空字串，避免把 `{{...}}` 寄給訂閱者。
 * `raw` 的鍵（例如簽名檔）在 HTML 模式不 escape，在純文字模式會去掉標籤。
 */
export function applyVariables(
  template: string,
  variables: Record<string, string>,
  mode: 'html' | 'text' = 'html',
  options?: { raw?: readonly string[] },
): string {
  const raw = new Set(options?.raw ?? []);
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key: string) => {
    const value = variables[key] ?? '';
    if (raw.has(key)) return mode === 'text' ? htmlToText(value) : value;
    return mode === 'html' ? escapeHtml(value) : value;
  });
}

/** 從 HTML 粗略生成純文字版本，讓收信端有 text/plain 可讀。 */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<figure\b[^>]*data-email-image-slot[^>]*>[\s\S]*?<\/figure>/gi, '')
    .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const attrOf = (raw: string, name: string): string => {
  const match = new RegExp(`${name}="([^"]*)"`, 'i').exec(raw);
  return match?.[1] ?? '';
};

/** 給引言、分隔線、按鈕、影音、圖片與正文排版補上信箱吃得下的 markup。 */
export function styleRichContent(html: string): string {
  const withComponents = html
    .replace(/<hr\b([^>]*)\/?>/gi, (match, attrs: string) => {
      if (/\s(?:style|data-email-style)\s*=/i.test(attrs ?? '')) return match;
      return `<hr style="border:0;border-top:1px solid ${EMAIL_COLORS.line};height:0;margin:40px 0;" />`;
    })
    .replace(/<div\b([^>]*data-email-btn[^>]*)>([\s\S]*?)<\/div>/gi, (_match, attrs: string, body: string) => {
      const href = attrOf(attrs, 'data-href') || '#';
      const label = body.replace(/<[^>]+>/g, '').trim() || '了解更多';
      const style = normalizeEmailButtonStyle({
        bg: attrOf(attrs, 'data-bg'),
        borderWidth: attrOf(attrs, 'data-border'),
        borderColor: attrOf(attrs, 'data-border-color'),
        radius: attrOf(attrs, 'data-radius'),
      });
      return emailButtonMarkup(escapeHtml(href), escapeHtml(label), style);
    })
    .replace(/<figure\b([^>]*data-email-audio[^>]*)>[\s\S]*?<\/figure>/gi, (_match, attrs: string) => {
      const src = attrOf(attrs, 'data-src');
      return src ? `<p style="margin:0 0 20px 0;"><a href="${escapeHtml(src)}">▶ 播放音訊</a></p>` : '';
    })
    .replace(/<figure\b([^>]*data-email-video[^>]*)>[\s\S]*?<\/figure>/gi, (_match, attrs: string) => {
      const src = attrOf(attrs, 'data-src');
      return src ? `<p style="margin:0 0 20px 0;"><a href="${escapeHtml(src)}">▶ 觀看影片</a></p>` : '';
    })
    .replace(/<figure\b([^>]*data-email-image-slot[^>]*)>[\s\S]*?<\/figure>/gi, (_match, attrs: string) => {
      const src = attrOf(attrs, 'data-src');
      if (!src) return '';
      const alt = escapeHtml(attrOf(attrs, 'data-alt') || attrOf(attrs, 'data-label') || '');
      return `<img src="${escapeHtml(src)}" alt="${alt}" width="${EMAIL_TEXT_WIDTH}" style="${EMAIL_IMAGE_STYLE}" />`;
    })
    .replace(/<img\b([^>]*)>/gi, (match, attrs: string) => {
      if (/\sstyle\s*=/i.test(attrs)) return match;
      const width = isFullWidthImageTag(match) ? EMAIL_CARD_WIDTH : EMAIL_TEXT_WIDTH;
      return setImgWidth(`<img${attrs} style="${imageInlineStyle(match)}">`, width);
    });
  return tightenAfterKicker(styleTypography(styleEmailBlocks(withComponents)));
}

export function absolutizeMediaUrls(html: string, baseUrl?: string): string {
  if (!baseUrl) return html;
  const origin = baseUrl.replace(/\/+$/, '');
  return html.replace(/(src=")(\/(?:media|sig-icons)\/[^"]+)/gi, `$1${origin}$2`);
}

/** 把完整信件 HTML 抽成 <body> 內容，給公開封存頁嵌進既有版型。 */
export function innerEmailHtml(documentHtml: string): string {
  const match = /<body[^>]*>([\s\S]*)<\/body>/i.exec(documentHtml);
  return (match?.[1] ?? documentHtml).trim();
}

export const EMAIL_CARD_WIDTH = 600;
export const EMAIL_FRAME_PAD = 24;
export const EMAIL_BODY_PAD_X = 40;
export const EMAIL_BODY_PAD_TOP = 44;
export const EMAIL_BODY_PAD_BOTTOM = 48;
/** 內文段落貼著滿版圖時，圖與字之間的距離。 */
export const EMAIL_BLEED_GAP = 36;
export const EMAIL_CANVAS_WIDTH = EMAIL_CARD_WIDTH + EMAIL_FRAME_PAD * 2;
export const EMAIL_TEXT_WIDTH = EMAIL_CARD_WIDTH - EMAIL_BODY_PAD_X * 2;

export interface EmailLayoutInput {
  subject: string;
  preheader?: string | undefined;
  contentHtml: string;
  siteName: string;
  publicBaseUrl?: string | undefined;
  unsubscribeUrl?: string | undefined;
  unsubscribePrompt?: string | undefined;
  unsubscribeLabel?: string | undefined;
  footerNote?: string | undefined;
  /** 線上閱讀網址（例如公開封存頁）。有給才在刊頭顯示連結。 */
  webViewUrl?: string | undefined;
  /**
   * 還沒放圖的空位怎麼處理。寄出、封存、後台預覽一律 `drop`（預設）；
   * 模板縮圖用 `placeholder` 畫出中性占位圖，讓人看得出版面。
   */
  imageSlots?: 'drop' | 'placeholder' | undefined;
}

const C = EMAIL_COLORS;

const FOOTER_TEXT = `font-family:${EMAIL_FONT};font-size:12px;line-height:1.75;letter-spacing:0.03em;color:${C.muted};`;

function unsubscribeLeadNeedsSpace(lead: string): boolean {
  return !/[\s？?！!：:、，,。]$/.test(lead);
}

/** 信件白卡片下方的退訂句。說明與連結文字都可在品牌頁改。 */
export function buildUnsubscribeHtml(
  url: string,
  prompt = DEFAULT_UNSUBSCRIBE_PROMPT,
  label = DEFAULT_UNSUBSCRIBE_LABEL,
): string {
  const lead = prompt.trim();
  const text = label.trim() || DEFAULT_UNSUBSCRIBE_LABEL;
  const link = `<a href="${escapeHtml(url)}" style="color:${C.soft};text-decoration:underline;text-underline-offset:2px;">${escapeHtml(text)}</a>`;
  const prefix = lead ? `${escapeHtml(lead)}${unsubscribeLeadNeedsSpace(lead) ? ' ' : ''}` : '';
  return `<p style="margin:0;${FOOTER_TEXT}">${prefix}${link}</p>`;
}

const BODY_TEXT = `font-family:${EMAIL_FONT};font-size:${EMAIL_BODY_SIZE}px;line-height:${EMAIL_BODY_LINE};letter-spacing:${EMAIL_BODY_TRACKING};color:${C.text};text-align:left;word-wrap:break-word;`;

function bleedRow(imgHtml: string): string {
  const img = setImgWidth(applyImgStyle(imgHtml, EMAIL_FULLWIDTH_STYLE), EMAIL_CARD_WIDTH);
  return `<tr><td style="padding:0;font-size:0;line-height:0;">${img}</td></tr>`;
}

function contentRow(html: string, padTop: number, padBottom: number): string {
  return `<tr>
          <td class="nk-pad" style="padding:${padTop}px ${EMAIL_BODY_PAD_X}px ${padBottom}px;${BODY_TEXT}">
            ${trimEdgeMargins(html)}
          </td>
        </tr>`;
}

function emailCardRows(coverHtml: string, bodyHtml: string): string {
  const coverRow = coverHtml ? bleedRow(coverHtml) : '';
  const segments = splitBleedSegments(bodyHtml).filter(
    (segment) => segment.type === 'bleed' || segment.html.trim(),
  );
  if (segments.length === 0) {
    return `${coverRow}${contentRow('', EMAIL_BODY_PAD_TOP, EMAIL_BODY_PAD_BOTTOM)}`;
  }
  const rows = segments.map((segment, index) => {
    if (segment.type === 'bleed') return bleedRow(segment.html);
    const afterBleed = index > 0 || Boolean(coverRow);
    const padTop = afterBleed ? EMAIL_BLEED_GAP + 4 : EMAIL_BODY_PAD_TOP;
    const padBottom = index === segments.length - 1 ? EMAIL_BODY_PAD_BOTTOM : EMAIL_BLEED_GAP;
    return contentRow(segment.html, padTop, padBottom);
  });
  return `${coverRow}${rows.join('')}`;
}

/** 收件匣預覽文字後面補空白字元，免得信箱把正文接在摘要後面。 */
function preheaderHtml(preheader: string | undefined): string {
  if (!preheader) return '';
  const filler = '&#8199;&#65279;&#847; '.repeat(48);
  return `<div class="nk-preheader" style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;color:transparent;height:0;width:0;mso-hide:all;">${escapeHtml(preheader)}${filler}</div>`;
}

/** 只在支援 <style> 的信箱生效：手機版留白、深色模式。沒有它版面也完整。 */
const HEAD_STYLE = `<style>
:root{color-scheme:light dark;supported-color-schemes:light dark;}
body{margin:0;padding:0;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}
a[x-apple-data-detectors]{color:inherit !important;text-decoration:none !important;}
@media screen and (max-width:640px){
  .nk-frame{padding:12px 0 32px !important;}
  .nk-card{border-radius:0 !important;border-left:0 !important;border-right:0 !important;}
  .nk-pad,.nk-edge{padding-left:24px !important;padding-right:24px !important;}
  .nk-card h1{font-size:26px !important;}
  .nk-card h2{font-size:20px !important;}
}
@media (prefers-color-scheme:dark){
  .nk-canvas,.nk-body{background:#161513 !important;}
  .nk-card{background:#1f1d1b !important;border-color:#302d29 !important;}
  .nk-pad,.nk-card p,.nk-card li,.nk-card td{color:#e6e1da !important;}
  .nk-card blockquote{color:#c9c2b8 !important;}
  .nk-card h1,.nk-card h2,.nk-card h3,.nk-card h4,.nk-card strong,.nk-card b{color:#f6f2ec !important;}
  .nk-card a:not(.nk-btn){color:#dfa877 !important;}
  .nk-card hr{border-top-color:#38342f !important;}
  .nk-card code,.nk-card pre{background:#2a2724 !important;}
  .nk-card [data-email-signature] td{border-top-color:#38342f !important;}
  .nk-card [data-email-signature] a img{filter:invert(1) !important;}
  .nk-card [data-email-signature] p + p{color:#a39b90 !important;}
  .nk-btn-dark{background:#f1ece4 !important;}
  .nk-btn-dark a{color:#171614 !important;}
  .nk-masthead,.nk-masthead td{color:#f1ece4 !important;}
  .nk-edge p,.nk-edge td{color:#a39b90 !important;}
  .nk-edge a{color:#d6cfc5 !important;}
}
${emailBlockHeadStyle()}
</style>`;

const MSO_HEAD = `<!--[if mso]>
<noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
<style>body,table,td,th,p,a,li,h1,h2,h3,h4,h5,h6,blockquote{font-family:'Microsoft JhengHei',Arial,sans-serif !important;}</style>
<![endif]-->`;

function mastheadHtml(siteName: string, webViewUrl: string | undefined): string {
  const name = siteName.trim();
  if (!name && !webViewUrl) return '';
  const webView = webViewUrl
    ? `<td align="right" valign="bottom" style="${FOOTER_TEXT}"><a href="${escapeHtml(webViewUrl)}" style="color:${C.muted};text-decoration:underline;text-underline-offset:2px;">線上閱讀</a></td>`
    : '';
  return `<tr>
          <td class="nk-edge nk-masthead" style="padding:8px ${EMAIL_BODY_PAD_X}px 18px;text-align:left;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td align="left" valign="bottom" style="font-family:${EMAIL_FONT};font-size:14px;line-height:1.4;font-weight:700;letter-spacing:0.12em;color:${C.ink};">${escapeHtml(name)}</td>
                ${webView}
              </tr>
            </table>
          </td>
        </tr>`;
}

function footerHtml(input: EmailLayoutInput): string {
  const lines: string[] = [];
  const name = input.siteName.trim();
  if (name) {
    lines.push(
      `<p style="margin:0 0 6px;${FOOTER_TEXT}font-weight:700;letter-spacing:0.12em;color:${C.soft};">${escapeHtml(name)}</p>`,
    );
  }
  if (input.footerNote) lines.push(`<p style="margin:0 0 4px;${FOOTER_TEXT}">${escapeHtml(input.footerNote)}</p>`);
  if (input.unsubscribeUrl) {
    lines.push(buildUnsubscribeHtml(input.unsubscribeUrl, input.unsubscribePrompt, input.unsubscribeLabel));
  }
  if (lines.length === 0) return '';
  return `<tr>
          <td class="nk-edge nk-footer" style="padding:28px ${EMAIL_BODY_PAD_X}px 8px;text-align:left;${FOOTER_TEXT}">
            ${lines.join('\n            ')}
          </td>
        </tr>`;
}

/**
 * 通用 email 版型：table 排版 + inline style，避免各家信箱把 CSS 丟掉。
 * 刊頭與頁尾放在白卡片外、對齊內文欄；滿版首圖貼齊卡片頂端。
 * 想換設計就改這裡與 email-theme.ts，核心不碰樣式。
 */
export function renderEmailLayout(input: EmailLayoutInput): string {
  const { subject } = input;
  const source =
    input.imageSlots === 'placeholder'
      ? fillImageSlotPlaceholders(input.contentHtml, EMAIL_TEXT_WIDTH, EMAIL_CARD_WIDTH, EMAIL_CARD_THUMB)
      : input.contentHtml;
  const split = splitLeadingHero(source);
  const coverHtml = split.coverHtml
    ? absolutizeMediaUrls(split.coverHtml, input.publicBaseUrl)
    : '';
  const contentHtml = absolutizeMediaUrls(styleRichContent(split.bodyHtml), input.publicBaseUrl);
  const shell = `role="presentation" width="${EMAIL_CARD_WIDTH}" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:${EMAIL_CARD_WIDTH}px;"`;

  return `<!doctype html>
<html lang="zh-Hant" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta http-equiv="X-UA-Compatible" content="IE=edge" />
<meta name="x-apple-disable-message-reformatting" />
<meta name="format-detection" content="telephone=no,date=no,address=no,email=no,url=no" />
<meta name="color-scheme" content="light dark" />
<meta name="supported-color-schemes" content="light dark" />
<title>${escapeHtml(subject)}</title>
${MSO_HEAD}
${HEAD_STYLE}
</head>
<body class="nk-body" style="margin:0;padding:0;background:${C.canvas};">
${preheaderHtml(input.preheader)}
<table class="nk-canvas" role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.canvas};">
  <tr>
    <td class="nk-frame" align="center" style="padding:${EMAIL_FRAME_PAD}px;">
      <!--[if mso]><table role="presentation" width="${EMAIL_CARD_WIDTH}" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
      <table ${shell}>
        ${mastheadHtml(input.siteName, input.webViewUrl)}
      </table>
      <table class="nk-card" role="presentation" width="${EMAIL_CARD_WIDTH}" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:${EMAIL_CARD_WIDTH}px;background:${C.card};border:1px solid ${C.line};border-radius:8px;border-collapse:separate;overflow:hidden;">
        ${emailCardRows(coverHtml, contentHtml)}
      </table>
      <table ${shell}>
        ${footerHtml(input)}
      </table>
      <!--[if mso]></td></tr></table><![endif]-->
    </td>
  </tr>
</table>
</body>
</html>`;
}

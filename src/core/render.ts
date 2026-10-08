import { marked } from 'marked';
import { emailButtonMarkup, normalizeEmailButtonStyle } from './email-button.js';
import {
  applyImgStyle,
  EMAIL_FULLWIDTH_STYLE,
  EMAIL_IMAGE_STYLE,
  imageInlineStyle,
  splitBleedSegments,
  splitLeadingHero,
} from './email-image.js';
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

/** 給引言、分隔線、按鈕、影音補上信箱吃得下的 markup。 */
export function styleRichContent(html: string): string {
  return html
    .replace(/<blockquote\b([^>]*)>/gi, (match, attrs: string) => {
      if (/\sstyle\s*=/i.test(attrs)) return match;
      return `<blockquote${attrs} style="margin:16px 0;padding:12px 16px;border-left:3px solid #a8a29e;background:#f5f5f4;">`;
    })
    .replace(/<hr\b([^>]*)\/?>/gi, (match, attrs: string) => {
      if (/\sstyle\s*=/i.test(attrs ?? '')) return match;
      return '<hr style="border:none;border-top:1px solid #d6d3d1;margin:24px 0;" />';
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
      return src ? `<p style="margin:16px 0;"><a href="${escapeHtml(src)}">播放音訊</a></p>` : '';
    })
    .replace(/<figure\b([^>]*data-email-video[^>]*)>[\s\S]*?<\/figure>/gi, (_match, attrs: string) => {
      const src = attrOf(attrs, 'data-src');
      return src ? `<p style="margin:16px 0;"><a href="${escapeHtml(src)}">觀看影片</a></p>` : '';
    })
    .replace(/<figure\b([^>]*data-email-image-slot[^>]*)>[\s\S]*?<\/figure>/gi, (_match, attrs: string) => {
      const src = attrOf(attrs, 'data-src');
      if (!src) return '';
      const alt = escapeHtml(attrOf(attrs, 'data-alt') || attrOf(attrs, 'data-label') || '');
      return `<img src="${escapeHtml(src)}" alt="${alt}" style="${EMAIL_IMAGE_STYLE}" />`;
    })
    .replace(/<img\b([^>]*)>/gi, (match, attrs: string) => {
      if (/\sstyle\s*=/i.test(attrs)) return match;
      return `<img${attrs} style="${imageInlineStyle(match)}">`;
    });
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
export const EMAIL_BODY_PAD_X = 32;
export const EMAIL_BODY_PAD_TOP = 28;
export const EMAIL_BODY_PAD_BOTTOM = 32;
export const EMAIL_CANVAS_WIDTH = EMAIL_CARD_WIDTH + EMAIL_FRAME_PAD * 2;

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
}

const EMAIL_FOOTER_FONT =
  "400 13px/1.7 -apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans TC','PingFang TC',sans-serif";

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
  const link = `<a href="${escapeHtml(url)}" style="color:#6b7280;">${escapeHtml(text)}</a>`;
  const prefix = lead ? `${escapeHtml(lead)}${unsubscribeLeadNeedsSpace(lead) ? ' ' : ''}` : '';
  return `<p style="margin:0;font:${EMAIL_FOOTER_FONT};color:#6b7280;">${prefix}${link}</p>`;
}

/**
 * 通用 email 版型：table 排版 + inline style，避免各家信箱把 CSS 丟掉。
 * 想換設計就改這一個函式，核心不碰樣式。
 */
const EMAIL_BODY_FONT =
  "400 16px/1.75 -apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans TC','PingFang TC',sans-serif";

function bleedRow(imgHtml: string): string {
  return `<tr><td style="padding:0;font-size:0;line-height:0;">${applyImgStyle(imgHtml, EMAIL_FULLWIDTH_STYLE)}</td></tr>`;
}

function contentRow(html: string, padTop: number, padBottom: number): string {
  return `<tr>
          <td style="padding:${padTop}px ${EMAIL_BODY_PAD_X}px ${padBottom}px;font:${EMAIL_BODY_FONT};color:#1c1917;">
            ${html}
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
  if (segments.length === 1 && segments[0]?.type === 'content') {
    return `${coverRow}${contentRow(segments[0].html, EMAIL_BODY_PAD_TOP, EMAIL_BODY_PAD_BOTTOM)}`;
  }
  const rows = segments.map((segment, index) => {
    if (segment.type === 'bleed') return bleedRow(segment.html);
    const padTop = index === 0 ? EMAIL_BODY_PAD_TOP : 16;
    const padBottom = index === segments.length - 1 ? EMAIL_BODY_PAD_BOTTOM : 16;
    return contentRow(segment.html, padTop, padBottom);
  });
  return `${coverRow}${rows.join('')}`;
}

export function renderEmailLayout(input: EmailLayoutInput): string {
  const { subject, preheader, unsubscribeUrl, footerNote } = input;
  const split = splitLeadingHero(input.contentHtml);
  const coverHtml = split.coverHtml
    ? absolutizeMediaUrls(split.coverHtml, input.publicBaseUrl)
    : '';
  const contentHtml = absolutizeMediaUrls(styleRichContent(split.bodyHtml), input.publicBaseUrl);
  const preheaderBlock = preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;height:0;width:0;">${escapeHtml(preheader)}</div>`
    : '';
  const unsubscribeBlock = unsubscribeUrl
    ? buildUnsubscribeHtml(unsubscribeUrl, input.unsubscribePrompt, input.unsubscribeLabel)
    : '';
  const noteBlock = footerNote
    ? `<p style="margin:${unsubscribeBlock ? '8px 0 0' : '0'};font:${EMAIL_FOOTER_FONT};color:#6b7280;">${escapeHtml(footerNote)}</p>`
    : '';
  const belowCard =
    unsubscribeBlock || noteBlock
      ? `<div style="max-width:${EMAIL_CARD_WIDTH}px;margin:16px auto 0;padding:0 ${EMAIL_BODY_PAD_X}px;text-align:left;">${unsubscribeBlock}${noteBlock}</div>`
      : '';

  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f4;">
${preheaderBlock}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f5f4;">
  <tr>
    <td align="center" style="padding:${EMAIL_FRAME_PAD}px;">
      <table role="presentation" width="${EMAIL_CARD_WIDTH}" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:${EMAIL_CARD_WIDTH}px;background:#ffffff;border-radius:12px;overflow:hidden;">
        ${emailCardRows(coverHtml, contentHtml)}
      </table>
      ${belowCard}
    </td>
  </tr>
</table>
</body>
</html>`;
}

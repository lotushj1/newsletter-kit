import { marked } from 'marked';
import { emailButtonMarkup, normalizeEmailButtonStyle } from './email-button.js';
import { EMAIL_HERO_STYLE, EMAIL_IMAGE_STYLE } from './email-image.js';

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
      const style = /data-email-hero/i.test(attrs) ? EMAIL_HERO_STYLE : EMAIL_IMAGE_STYLE;
      return `<img${attrs} style="${style}">`;
    });
}

export function absolutizeMediaUrls(html: string, baseUrl?: string): string {
  if (!baseUrl) return html;
  const origin = baseUrl.replace(/\/+$/, '');
  return html.replace(/(src=")(\/media\/[^"]+)/gi, `$1${origin}$2`);
}

export interface EmailLayoutInput {
  subject: string;
  preheader?: string | undefined;
  contentHtml: string;
  siteName: string;
  publicBaseUrl?: string | undefined;
  unsubscribeUrl?: string | undefined;
  footerNote?: string | undefined;
}

/**
 * 通用 email 版型：table 排版 + inline style，避免各家信箱把 CSS 丟掉。
 * 想換設計就改這一個函式，核心不碰樣式。
 */
export function renderEmailLayout(input: EmailLayoutInput): string {
  const { subject, preheader, siteName, unsubscribeUrl, footerNote } = input;
  const contentHtml = absolutizeMediaUrls(styleRichContent(input.contentHtml), input.publicBaseUrl);
  const preheaderBlock = preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;height:0;width:0;">${escapeHtml(preheader)}</div>`
    : '';
  const unsubscribeBlock = unsubscribeUrl
    ? `<p style="margin:0 0 8px;">不想再收到這封信？<a href="${escapeHtml(unsubscribeUrl)}" style="color:#6b7280;">取消訂閱</a></p>`
    : '';
  const noteBlock = footerNote ? `<p style="margin:0;">${escapeHtml(footerNote)}</p>` : '';

  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f4;">
${preheaderBlock}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f5f4;padding:24px 12px;">
  <tr>
    <td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;">
        <tr>
          <td style="padding:24px 32px 8px;font:600 14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans TC','PingFang TC',sans-serif;color:#78716c;letter-spacing:.04em;">
            ${escapeHtml(siteName)}
          </td>
        </tr>
        <tr>
          <td style="padding:0 32px 32px;font:400 16px/1.75 -apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans TC','PingFang TC',sans-serif;color:#1c1917;">
            ${contentHtml}
          </td>
        </tr>
        <tr>
          <td style="padding:20px 32px 28px;border-top:1px solid #e7e5e4;font:400 13px/1.7 -apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans TC','PingFang TC',sans-serif;color:#6b7280;">
            ${unsubscribeBlock}
            ${noteBlock}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

import { marked } from 'marked';

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
 */
export function applyVariables(
  template: string,
  variables: Record<string, string>,
  mode: 'html' | 'text' = 'html',
): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key: string) => {
    const value = variables[key] ?? '';
    return mode === 'html' ? escapeHtml(value) : value;
  });
}

/** 從 HTML 粗略生成純文字版本，讓收信端有 text/plain 可讀。 */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
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

export interface EmailLayoutInput {
  subject: string;
  preheader?: string | undefined;
  contentHtml: string;
  siteName: string;
  unsubscribeUrl?: string | undefined;
  footerNote?: string | undefined;
}

/**
 * 通用 email 版型：table 排版 + inline style，避免各家信箱把 CSS 丟掉。
 * 想換設計就改這一個函式，核心不碰樣式。
 */
export function renderEmailLayout(input: EmailLayoutInput): string {
  const { subject, preheader, contentHtml, siteName, unsubscribeUrl, footerNote } = input;
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

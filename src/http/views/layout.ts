import { escapeHtml } from '../../core/render.js';

export const STYLES = `
:root{
  --bg:#faf9f7; --panel:#fff; --ink:#1c1917; --muted:#78716c; --line:#e7e5e4;
  --accent:#0f766e; --accent-soft:#ccfbf1; --warn:#b45309; --danger:#b91c1c;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
  font:400 15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans TC","PingFang TC",sans-serif}
a{color:var(--accent)}
header.topbar{display:flex;align-items:center;gap:20px;padding:14px 24px;background:var(--panel);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:10;flex-wrap:wrap}
header.topbar .brand{font-weight:700;letter-spacing:.02em}
header.topbar nav{display:flex;gap:16px;flex:1;flex-wrap:wrap}
header.topbar nav a{color:var(--muted);text-decoration:none;padding:4px 0;border-bottom:2px solid transparent}
header.topbar nav a.active,header.topbar nav a:hover{color:var(--ink);border-bottom-color:var(--accent)}
main{max-width:1040px;margin:0 auto;padding:28px 24px 64px}
h1{font-size:24px;margin:0 0 4px}
h2{font-size:17px;margin:28px 0 12px}
p.lede{color:var(--muted);margin:0 0 24px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:20px;margin-bottom:20px}
.grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(160px,1fr))}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px}
.stat b{display:block;font-size:26px;line-height:1.2}
.stat span{color:var(--muted);font-size:13px}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:10px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600;font-size:13px}
label{display:block;margin:14px 0 6px;font-size:13px;color:var(--muted)}
input,textarea,select{width:100%;padding:9px 11px;border:1px solid var(--line);border-radius:8px;
  background:#fff;color:var(--ink);font:inherit}
textarea{min-height:280px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;line-height:1.6}
button,.btn{display:inline-block;padding:9px 16px;border-radius:8px;border:1px solid var(--accent);
  background:var(--accent);color:#fff;font:inherit;cursor:pointer;text-decoration:none}
button.ghost,.btn.ghost{background:transparent;color:var(--accent)}
button.danger,.btn.danger{background:transparent;border-color:var(--danger);color:var(--danger)}
button:disabled{opacity:.5;cursor:not-allowed}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.row.between{justify-content:space-between}
.pill{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px;border:1px solid var(--line);color:var(--muted)}
.pill.subscribed,.pill.sent{background:var(--accent-soft);border-color:#99f6e4;color:#115e59}
.pill.pending,.pill.scheduled,.pill.sending{background:#fef3c7;border-color:#fde68a;color:var(--warn)}
.pill.unsubscribed,.pill.failed,.pill.bounced,.pill.canceled{background:#fee2e2;border-color:#fecaca;color:var(--danger)}
.notice{padding:12px 14px;border-radius:8px;background:#fff;border:1px solid var(--line);margin-bottom:16px}
.notice.warn{background:#fffbeb;border-color:#fde68a;color:#92400e}
.notice.error{background:#fef2f2;border-color:#fecaca;color:var(--danger)}
.notice.ok{background:#f0fdfa;border-color:#99f6e4;color:#115e59}
.muted{color:var(--muted)}
.split{display:grid;gap:20px;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr)}
@media(max-width:860px){.split{grid-template-columns:1fr}}
iframe.preview{width:100%;height:520px;border:1px solid var(--line);border-radius:8px;background:#fff}
code{background:#f5f5f4;padding:1px 5px;border-radius:4px;font-size:13px}
.center-card{max-width:400px;margin:12vh auto;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:28px}
`;

export interface PageOptions {
  title: string;
  siteName: string;
  body: string;
  activeNav?: string | undefined;
  chrome?: boolean;
}

const NAV: { href: string; key: string; label: string }[] = [
  { href: '/admin', key: 'dashboard', label: '總覽' },
  { href: '/admin/campaigns', key: 'campaigns', label: '電子報' },
  { href: '/admin/subscribers', key: 'subscribers', label: '訂閱名單' },
  { href: '/admin/settings', key: 'settings', label: '設定' },
];

export function page(options: PageOptions): string {
  const { title, siteName, body, activeNav, chrome = true } = options;
  const nav = NAV.map(
    (item) =>
      `<a href="${item.href}"${activeNav === item.key ? ' class="active"' : ''}>${item.label}</a>`,
  ).join('');
  const header = chrome
    ? `<header class="topbar"><span class="brand">${escapeHtml(siteName)}</span><nav>${nav}</nav>
       <form method="post" action="/admin/logout"><button class="ghost" type="submit">登出</button></form></header>`
    : '';
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head>
<body>
${header}
<main>${body}</main>
</body>
</html>`;
}

/** 訂閱者看到的公開頁（確認、退訂），不掛後台導覽。 */
export function publicPage(siteName: string, title: string, bodyHtml: string): string {
  return page({
    title,
    siteName,
    chrome: false,
    body: `<div class="center-card"><p class="muted" style="margin:0 0 12px">${escapeHtml(siteName)}</p>${bodyHtml}</div>`,
  });
}

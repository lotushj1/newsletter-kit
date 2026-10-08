import { escapeHtml } from '../../core/render.js';

/**
 * shadcn/ui 視覺：官方 semantic token（neutral）
 * https://ui.shadcn.com/docs/theming
 * 淺色 Sidebar + Card / Table / Button / Badge / Alert。
 */
export const STYLES = `
:root{
  --radius:0.625rem;
  --background:oklch(1 0 0);
  --foreground:oklch(0.145 0 0);
  --card:oklch(1 0 0);
  --card-foreground:oklch(0.145 0 0);
  --primary:oklch(0.205 0 0);
  --primary-foreground:oklch(0.985 0 0);
  --secondary:oklch(0.97 0 0);
  --secondary-foreground:oklch(0.205 0 0);
  --muted:oklch(0.97 0 0);
  --muted-foreground:oklch(0.556 0 0);
  --accent:oklch(0.97 0 0);
  --accent-foreground:oklch(0.205 0 0);
  --destructive:oklch(0.577 0.245 27.325);
  --border:oklch(0.922 0 0);
  --input:oklch(0.922 0 0);
  --ring:oklch(0.708 0 0);
  --sidebar:oklch(0.985 0 0);
  --sidebar-foreground:oklch(0.145 0 0);
  --sidebar-primary:oklch(0.205 0 0);
  --sidebar-primary-foreground:oklch(0.985 0 0);
  --sidebar-accent:oklch(0.97 0 0);
  --sidebar-accent-foreground:oklch(0.205 0 0);
  --sidebar-border:oklch(0.922 0 0);
  --radius-sm:calc(var(--radius) * 0.6);
  --radius-md:calc(var(--radius) * 0.8);
  --radius-lg:var(--radius);
}
*{box-sizing:border-box}
html,body{min-height:100%}
body{margin:0;background:var(--background);color:var(--foreground);
  font:400 14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans TC","PingFang TC",sans-serif;
  -webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
a:hover{text-decoration:underline;text-underline-offset:4px}
code{background:var(--muted);padding:2px 6px;border-radius:var(--radius-sm);font-size:12px;
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}

.ad-app{display:flex;min-height:100vh;align-items:flex-start}
.ad-sider{width:12rem;flex-shrink:0;background:var(--sidebar);color:var(--sidebar-foreground);
  display:flex;flex-direction:column;border-right:1px solid var(--sidebar-border);overflow:hidden;
  position:sticky;top:0;height:100vh;height:100dvh}
.ad-logo{height:3.5rem;display:flex;align-items:center;gap:8px;padding:0 12px;
  font-weight:600;font-size:14px;letter-spacing:-0.01em;border-bottom:1px solid var(--sidebar-border);
  white-space:nowrap;overflow:hidden}
.ad-logo svg{flex-shrink:0}
.ad-menu{padding:8px;display:flex;flex-direction:column;gap:2px;flex:1}
.ad-menu a{display:flex;align-items:center;gap:8px;height:2rem;padding:0 8px;border-radius:var(--radius-md);
  color:var(--sidebar-foreground);text-decoration:none;font-size:14px;white-space:nowrap;overflow:hidden}
.ad-menu a:hover{background:var(--sidebar-accent);color:var(--sidebar-accent-foreground);text-decoration:none}
.ad-menu a.active{background:var(--sidebar-accent);color:var(--sidebar-accent-foreground);font-weight:500}
.ad-menu svg{width:16px;height:16px;flex-shrink:0}
.ad-main{flex:1;min-width:0;display:flex;flex-direction:column;background:var(--background)}
.ad-header{height:3.5rem;background:var(--background);display:flex;align-items:center;justify-content:space-between;
  padding:0 1.5rem;border-bottom:1px solid var(--border);position:sticky;top:0;z-index:10}
.ad-header .crumb{color:var(--muted-foreground);font-size:14px}
.ad-header .crumb b{color:var(--foreground);font-weight:500}
.ad-content{padding:1.5rem;flex:1}
.ad-sider-foot{margin-top:auto;padding:8px;border-top:1px solid var(--sidebar-border);display:flex;justify-content:flex-start}
html.sidebar-collapsed .ad-sider{width:3rem}
html.sidebar-collapsed .ad-logo{justify-content:center;padding:0}
html.sidebar-collapsed .ad-logo span,html.sidebar-collapsed .ad-menu a span{display:none}
html.sidebar-collapsed .ad-menu{padding:8px 4px}
html.sidebar-collapsed .ad-menu a{justify-content:center;padding:0}
html.sidebar-collapsed .ad-sider-foot{padding:8px 4px}
@media (prefers-reduced-motion: no-preference){
  .ad-sider{transition:width .2s ease}
}

.ad-page-header{margin-bottom:1.5rem}
.ad-page-header-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}
.ad-page-header-title{font-size:1.5rem;font-weight:600;letter-spacing:-0.025em;line-height:1.2;margin:0}
.ad-page-header-content{color:var(--muted-foreground);margin:6px 0 0;font-size:14px}
.ad-page-header-extra{display:flex;gap:8px;align-items:center}

h1{font-size:1.5rem;font-weight:600;letter-spacing:-0.025em;line-height:1.2;margin:0 0 4px}
h2{font-size:14px;font-weight:600;margin:0 0 12px}
p.lede{color:var(--muted-foreground);margin:0 0 16px}

.card{background:var(--card);color:var(--card-foreground);border-radius:var(--radius-lg);padding:1.5rem;
  margin-bottom:1rem;border:1px solid var(--border);box-shadow:0 1px 2px oklch(0.145 0 0 / 0.04);overflow-x:auto}
.grid{display:grid;gap:1rem;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));margin-bottom:1rem}
.stat{background:var(--card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:1.25rem 1.5rem}
a.stat{text-decoration:none;color:inherit;display:block}
a.stat:hover{background:var(--accent);text-decoration:none}
.stat b{display:block;font-size:1.5rem;line-height:1.2;font-weight:600;letter-spacing:-0.025em;font-variant-numeric:tabular-nums}
.stat span{color:var(--muted-foreground);font-size:13px}

table{width:100%;border-collapse:separate;border-spacing:0;font-size:14px}
th,td{text-align:left;padding:12px 16px;border-bottom:1px solid var(--border);vertical-align:top}
thead th{background:transparent;color:var(--muted-foreground);font-weight:500;font-size:13px}
tbody tr:hover td{background:var(--muted)}
td a{font-weight:500}
.card > table tbody tr:last-child td{border-bottom:0}
td.actions{width:1%;white-space:nowrap;text-align:right;vertical-align:middle}
td.actions .act{height:2rem;padding:0 10px;font-size:13px}
td.actions .act + .act{margin-left:8px}

label{display:block;margin:16px 0 8px;font-size:14px;font-weight:500;color:var(--foreground)}
form label:first-of-type{margin-top:0}
.ad-form-item{margin-bottom:16px}
.ad-form-item .hint{margin:4px 0 0;color:var(--muted-foreground);font-size:12px}
input,textarea,select{width:100%;height:2.25rem;padding:0 12px;border:1px solid var(--input);
  border-radius:var(--radius-md);background:var(--background);color:var(--foreground);font:inherit;
  transition:border-color .15s,box-shadow .15s}
textarea{height:auto;min-height:280px;padding:8px 12px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;line-height:1.6}
input::placeholder,textarea::placeholder{color:var(--muted-foreground)}
input:focus,textarea:focus,select:focus{outline:none;border-color:var(--ring);box-shadow:0 0 0 3px oklch(0.708 0 0 / 0.35)}
input:disabled,textarea:disabled,select:disabled{opacity:.5;cursor:not-allowed}

button,.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:2.25rem;padding:0 1rem;
  border-radius:var(--radius-md);border:1px solid var(--primary);background:var(--primary);color:var(--primary-foreground);
  font:inherit;font-weight:500;font-size:14px;cursor:pointer;text-decoration:none;
  transition:background .15s,opacity .15s,color .15s}
button:hover,.btn:hover{opacity:.9;text-decoration:none;color:var(--primary-foreground)}
button:active,.btn:active{transform:scale(0.96)}
button.ghost,.btn.ghost{background:var(--background);color:var(--foreground);border-color:var(--border)}
button.ghost:hover,.btn.ghost:hover{background:var(--accent);color:var(--accent-foreground);opacity:1}
button.icon-btn{width:2rem;height:2rem;padding:0;background:transparent;border-color:transparent;color:var(--foreground)}
button.icon-btn:hover{background:var(--accent);color:var(--accent-foreground);opacity:1}
button.icon-btn:focus-visible{outline:2px solid var(--ring);outline-offset:2px}
button.danger,.btn.danger{background:var(--background);border-color:var(--border);color:var(--destructive)}
button.danger:hover,.btn.danger:hover{background:var(--destructive);color:#fff;border-color:var(--destructive);opacity:1}
button.chip{height:1.75rem;padding:0 10px;font-size:12px;font-weight:500;border-radius:var(--radius-md);
  background:var(--background);color:var(--foreground);border-color:var(--border)}
button.chip:hover{background:var(--accent)}
button:disabled{opacity:.5;cursor:not-allowed}

.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.row.between{justify-content:space-between}

.pill{display:inline-flex;align-items:center;padding:0 8px;height:1.25rem;border-radius:var(--radius-md);
  font-size:12px;font-weight:500;border:1px solid var(--border);background:var(--secondary);color:var(--secondary-foreground)}
.pill.subscribed,.pill.sent{background:var(--secondary);border-color:transparent}
.pill.pending,.pill.scheduled,.pill.sending{background:transparent}
.pill.unsubscribed,.pill.failed,.pill.bounced,.pill.canceled{background:oklch(0.577 0.245 27.325 / 0.1);border-color:transparent;color:var(--destructive)}

.notice{padding:12px 16px;border-radius:var(--radius-lg);background:var(--card);border:1px solid var(--border);
  color:var(--foreground);margin-bottom:1rem;font-size:14px}
.notice.warn{border-color:var(--border);background:var(--muted)}
.notice.error{border-color:oklch(0.577 0.245 27.325 / 0.3);color:var(--destructive)}
.notice.ok{border-color:var(--border);background:var(--secondary)}
.muted{color:var(--muted-foreground)}
.save-status{font-size:13px;color:var(--muted-foreground)}

.filters{display:inline-flex;flex-wrap:wrap;padding:3px;background:var(--muted);border-radius:var(--radius-md);margin:0 0 1rem}
.filters a{color:var(--muted-foreground);text-decoration:none;padding:0 12px;height:2rem;line-height:2rem;
  border-radius:calc(var(--radius-md) - 2px);font-size:14px;font-weight:500}
.filters a.active,.filters a:hover{color:var(--foreground);background:var(--background);box-shadow:0 1px 2px oklch(0.145 0 0 / 0.06);text-decoration:none}

.progress{height:8px;background:var(--secondary);border-radius:999px;overflow:hidden;margin:8px 0 10px}
.progress-bar{height:100%;width:0;background:var(--primary);transition:width .2s ease;border-radius:999px}
.preview-subject{font-weight:600;margin:0 0 10px;font-size:16px;letter-spacing:-0.01em}
.pager{margin-top:16px;justify-content:flex-end}
.split{display:grid;gap:1rem;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr)}
@media(max-width:992px){
  html:not(.sidebar-expanded) .ad-sider{width:3rem}
  html:not(.sidebar-expanded) .ad-logo{justify-content:center;padding:0}
  html:not(.sidebar-expanded) .ad-logo span,html:not(.sidebar-expanded) .ad-menu a span{display:none}
  html:not(.sidebar-expanded) .ad-menu{padding:8px 4px}
  html:not(.sidebar-expanded) .ad-menu a{justify-content:center;padding:0}
  html:not(.sidebar-expanded) .ad-sider-foot{padding:8px 4px}
  .split{grid-template-columns:1fr}
}
iframe.preview{width:100%;height:520px;border:1px solid var(--border);border-radius:var(--radius-md);background:var(--background)}

.center-card,.archive-wrap{max-width:26rem;margin:0 auto;background:var(--card);border:1px solid var(--border);
  border-radius:var(--radius-lg);padding:2rem;box-shadow:0 1px 2px oklch(0.145 0 0 / 0.04)}
.archive-wrap{width:min(42rem,100%);max-width:42rem}
.ad-result-icon{width:3rem;height:3rem;border-radius:999px;display:flex;align-items:center;justify-content:center;
  margin:0 auto 1.25rem;font-size:1.25rem;border:1px solid var(--border);background:var(--secondary)}
.ad-result-icon.ok{background:var(--primary);color:var(--primary-foreground);border:0}
.ad-result-icon.warn{background:var(--secondary);color:var(--foreground)}
.ad-result-icon.error{background:var(--destructive);color:#fff}
.ad-login-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--muted);padding:1.5rem}
.ad-login-wrap .center-card{margin:0}
`;

export interface PageOptions {
  title: string;
  siteName: string;
  body: string;
  activeNav?: string | undefined;
  chrome?: boolean;
}

const NAV: { href: string; key: string; label: string; icon: string }[] = [
  {
    href: '/admin',
    key: 'dashboard',
    label: '總覽',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/></svg>',
  },
  {
    href: '/admin/campaigns',
    key: 'campaigns',
    label: '電子報',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><path d="m22 6-10 7L2 6"/></svg>',
  },
  {
    href: '/admin/subscribers',
    key: 'subscribers',
    label: '訂閱名單',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="7" r="3"/><path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2"/><path d="M16 3.13a3 3 0 0 1 0 5.75"/><path d="M21 21v-2a4 4 0 0 0-3-3.87"/></svg>',
  },
  {
    href: '/admin/settings',
    key: 'settings',
    label: '設定',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  },
];

const NAV_LABEL: Record<string, string> = {
  dashboard: '總覽',
  campaigns: '電子報',
  subscribers: '訂閱名單',
  settings: '設定',
};

export function page(options: PageOptions): string {
  const { title, siteName, body, activeNav, chrome = true } = options;
  const nav = NAV.map(
    (item) =>
      `<a href="${item.href}" title="${item.label}" aria-label="${item.label}"${activeNav === item.key ? ' class="active"' : ''}>${item.icon}<span>${item.label}</span></a>`,
  ).join('');
  const crumb = activeNav ? NAV_LABEL[activeNav] ?? '' : '';
  const header = chrome
    ? `<div class="ad-app">
  <aside class="ad-sider" id="admin-sidebar">
    <div class="ad-logo">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect width="24" height="24" rx="6" fill="oklch(0.205 0 0)"/><path d="M7 8h10v2H7zm0 4h7v2H7z" fill="oklch(0.985 0 0)"/></svg>
      <span>${escapeHtml(siteName)}</span>
    </div>
    <nav class="ad-menu">${nav}</nav>
    <div class="ad-sider-foot">
      <button type="button" class="ghost icon-btn" id="sidebar-toggle" aria-controls="admin-sidebar" aria-expanded="true" aria-label="收合側邊欄" title="收合側邊欄">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/></svg>
      </button>
    </div>
  </aside>
  <div class="ad-main">
    <header class="ad-header">
      <div class="crumb"><b>${escapeHtml(crumb)}</b></div>
      <form method="post" action="/admin/logout"><button class="ghost" type="submit">登出</button></form>
    </header>
    <div class="ad-content">${body}</div>
  </div>
</div>
<script>
(function () {
  var KEY = 'nk-sidebar';
  var root = document.documentElement;
  var btn = document.getElementById('sidebar-toggle');
  if (!btn) return;
  function collapsed() { return root.classList.contains('sidebar-collapsed'); }
  function sync() {
    var c = collapsed();
    btn.setAttribute('aria-expanded', String(!c));
    btn.setAttribute('aria-label', c ? '展開側邊欄' : '收合側邊欄');
    btn.setAttribute('title', c ? '展開側邊欄' : '收合側邊欄');
  }
  function set(c) {
    root.classList.toggle('sidebar-collapsed', c);
    root.classList.toggle('sidebar-expanded', !c);
    try { localStorage.setItem(KEY, c ? 'collapsed' : 'expanded'); } catch (e) {}
    sync();
  }
  btn.addEventListener('click', function () { set(!collapsed()); });
  sync();
})();
</script>`
    : body;
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
<script>
(function () {
  try {
    var s = localStorage.getItem('nk-sidebar');
    if (s === 'collapsed') document.documentElement.classList.add('sidebar-collapsed');
    if (s === 'expanded') document.documentElement.classList.add('sidebar-expanded');
  } catch (e) {}
})();
</script>
</head>
<body>
${header}
</body>
</html>`;
}

/** 訂閱者看到的公開頁（確認、退訂），不掛後台導覽。 */
export function publicPage(siteName: string, title: string, bodyHtml: string): string {
  return page({
    title,
    siteName,
    chrome: false,
    body: `<div class="ad-login-wrap"><div class="center-card"><p class="muted" style="margin:0 0 12px;text-align:center">${escapeHtml(siteName)}</p>${bodyHtml}</div></div>`,
  });
}

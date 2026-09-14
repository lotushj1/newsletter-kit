import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { LayoutDashboard, LogOut, Mail, PanelLeft, PenLine, Settings, Users, Workflow } from 'lucide-react';
import { api, type Session } from '../api';

const LINKS = [
  { to: '/', label: '總覽', icon: LayoutDashboard, end: true },
  { to: '/campaigns', label: '電子報', icon: Mail },
  { to: '/subscribers', label: '名單', icon: Users },
  { to: '/sequences', label: '自動化', icon: Workflow },
  { to: '/brand', label: '品牌', icon: PenLine },
  { to: '/settings', label: '設定', icon: Settings },
];

const CRUMB: Record<string, string> = {
  '/': '總覽',
  '/campaigns': '電子報',
  '/subscribers': '名單',
  '/sequences': '自動化',
  '/brand': '品牌',
  '/settings': '設定',
};

export function Layout() {
  const location = useLocation();
  const [session, setSession] = useState<Session | null>(null);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem('nk-sidebar') === 'collapsed';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    void api.get<Session>('/session').then(setSession);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle('sidebar-collapsed', collapsed);
    try {
      localStorage.setItem('nk-sidebar', collapsed ? 'collapsed' : 'expanded');
    } catch {
      /* ignore */
    }
  }, [collapsed]);

  const crumb = location.pathname.startsWith('/campaigns/')
    ? '寫稿'
    : location.pathname.startsWith('/sequences/')
      ? '編輯自動化'
      : location.pathname.startsWith('/brand/templates/')
        ? '編輯模板'
        : (CRUMB[location.pathname] ?? '');
  const isEditor = /^\/(campaigns|sequences)\/[^/]+$/.test(location.pathname)
    || location.pathname.startsWith('/brand/templates/');

  return (
    <div className="ad-app">
      <aside className="ad-sider">
        <div className="ad-logo">
          <Mail size={16} />
          <span>{session?.siteName ?? 'Newsletter'}</span>
        </div>
        <nav className="ad-menu">
          {LINKS.map((link) => (
            <NavLink key={link.to} to={link.to} end={link.end} className={({ isActive }) => (isActive ? 'active' : '')}>
              <link.icon size={16} />
              <span>{link.label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="ad-sider-foot">
          <button
            type="button"
            className="icon"
            aria-label={collapsed ? '展開側邊欄' : '收合側邊欄'}
            onClick={() => setCollapsed((c) => !c)}
          >
            <PanelLeft size={16} />
          </button>
          <form method="post" action="/admin/logout">
            <button className="icon" type="submit" aria-label="登出">
              <LogOut size={16} />
            </button>
          </form>
        </div>
      </aside>
      <div className="ad-main">
        <header className="ad-header">
          <div style={{ color: 'var(--foreground)', fontWeight: 500 }}>{crumb}</div>
        </header>
        <div className={isEditor ? 'ad-content editor' : 'ad-content'}>
          <Outlet context={session} />
        </div>
      </div>
    </div>
  );
}

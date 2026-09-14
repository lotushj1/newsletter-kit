import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { MoreHorizontal } from 'lucide-react';
import { api, formatRate, formatTime, STATUS_LABEL, type Campaign, type CampaignTemplate, type Folder } from '../api';
import { DateRangePicker } from '../components/DateRangePicker';
import { CreateCampaignDialog } from '../components/CreateCampaignDialog';
import { FolderBar, type FolderFilter } from '../components/FolderBar';

const STATUSES = ['draft', 'scheduled', 'sending', 'sent', 'failed', 'canceled'];
const PAGE = 25;

function campaignWhen(campaign: Campaign): string {
  if (campaign.status === 'sent' && campaign.sentAt) return `寄出 ${formatTime(campaign.sentAt)}`;
  if (campaign.status === 'scheduled' && campaign.scheduledAt) return `排程 ${formatTime(campaign.scheduledAt)}`;
  return `上次編輯 ${formatTime(campaign.updatedAt)}`;
}

function metric(sent: number, count: number): { value: string; rate: string } {
  if (sent <= 0) return { value: '—', rate: '—' };
  return { value: String(count), rate: formatRate(count / sent, sent) };
}

export function Campaigns() {
  const navigate = useNavigate();
  const [items, setItems] = useState<Campaign[]>([]);
  const [total, setTotal] = useState(0);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [folderFilter, setFolderFilter] = useState<FolderFilter>('all');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [folderMenuOpen, setFolderMenuOpen] = useState(false);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [savingTemplateId, setSavingTemplateId] = useState<string | null>(null);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    if (status) params.set('status', status);
    if (from) params.set('from', new Date(from).toISOString());
    if (to) params.set('to', new Date(`${to}T23:59:59`).toISOString());
    if (folderFilter === 'unfiled') params.set('folderId', 'unfiled');
    else if (folderFilter !== 'all') params.set('folderId', folderFilter);
    params.set('limit', String(PAGE));
    params.set('offset', String(offset));
    return params.toString();
  }, [search, status, from, to, folderFilter, offset]);

  const loadFolders = () =>
    api
      .get<{ items: Folder[]; unfiled: number; total: number }>('/campaign-folders')
      .then((data) => {
        setFolders(data.items);
      });

  const loadCampaigns = () =>
    api.get<{ items: Campaign[]; total: number }>(`/campaigns?${query}`).then((data) => {
      setItems(data.items);
      setTotal(data.total);
      setSelected((current) => current.filter((id) => data.items.some((item) => item.id === id)));
    });

  useEffect(() => {
    void loadFolders().catch((err: Error) => setError(err.message));
  }, []);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      void loadCampaigns().catch((err: Error) => setError(err.message));
    }, 200);
    return () => window.clearTimeout(handle);
  }, [query]);

  useEffect(() => {
    if (!menuId && !folderMenuOpen) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest('[data-campaign-menu]') || target.closest('[data-bulk-folder]')) return;
      setMenuId(null);
      setFolderMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuId(null);
        setFolderMenuOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuId, folderMenuOpen]);

  const fail = (err: Error) => setError(err.message);

  const folderId = folderFilter !== 'all' && folderFilter !== 'unfiled' ? folderFilter : undefined;

  const create = async () => {
    setCreating(true);
    try {
      const created = await api.post<Campaign>('/campaigns', {
        title: `未命名電子報 ${new Date().toLocaleString('zh-TW', { hour12: false })}`,
        bodyHtml: '<p>嗨 {{name}}，</p><p>這裡是這期的內容。</p>',
        folderId,
      });
      navigate(`/campaigns/${created.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : '建立失敗');
      setCreating(false);
    }
  };

  const createFromTemplate = async (template: CampaignTemplate, title: string) => {
    setCreating(true);
    setError('');
    try {
      const fallbackTitle =
        template.id === '__blank__'
          ? `未命名電子報 ${new Date().toLocaleString('zh-TW', { hour12: false })}`
          : template.title;
      const nextTitle = title.trim() || fallbackTitle;
      const created = await api.post<Campaign>('/campaigns', {
        title: nextTitle,
        subject: nextTitle,
        preheader: template.preheader,
        bodyHtml: template.bodyHtml,
        folderId,
      });
      navigate(`/campaigns/${created.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : '建立失敗');
      setCreating(false);
    }
  };

  const saveAsTemplate = async (campaign: Campaign) => {
    setSavingTemplateId(campaign.id);
    setError('');
    try {
      const created = await api.post<CampaignTemplate>(`/campaigns/${campaign.id}/template`);
      navigate(`/brand/templates/${created.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : '存成模板失敗');
      setSavingTemplateId(null);
    }
  };

  const createFolder = async (name: string) => {
    try {
      const folder = await api.post<Folder>('/campaign-folders', { name });
      setFolderFilter(folder.id);
      setOffset(0);
      await loadFolders();
    } catch (err) {
      fail(err instanceof Error ? err : new Error('建立失敗'));
      throw err;
    }
  };

  const saveRename = async (id: string, name: string) => {
    try {
      await api.patch(`/campaign-folders/${id}`, { name });
      await loadFolders();
    } catch (err) {
      fail(err instanceof Error ? err : new Error('重新命名失敗'));
      throw err;
    }
  };

  const removeFolder = (folder: Folder) => {
    if (!window.confirm(`刪除「${folder.name}」？裡面的電子報會回到未分類，不會被刪除。`)) return;
    void api
      .delete(`/campaign-folders/${folder.id}`)
      .then(() => {
        if (folderFilter === folder.id) setFolderFilter('all');
        void loadFolders();
        void loadCampaigns();
      })
      .catch(fail);
  };

  const remove = async (campaign: Campaign) => {
    if (!window.confirm(`刪除「${campaign.title}」？`)) return;
    try {
      await api.delete(`/campaigns/${campaign.id}`);
      setSelected((current) => current.filter((id) => id !== campaign.id));
      await Promise.all([loadCampaigns(), loadFolders()]);
    } catch (err) {
      fail(err instanceof Error ? err : new Error('刪除失敗'));
    }
  };

  const toggleOne = (id: string) => {
    setSelected((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  };

  const allOnPageSelected = items.length > 0 && items.every((item) => selected.includes(item.id));

  const togglePage = () => {
    if (allOnPageSelected) {
      setSelected((current) => current.filter((id) => !items.some((item) => item.id === id)));
      return;
    }
    setSelected((current) => [...new Set([...current, ...items.map((item) => item.id)])]);
  };

  const moveSelected = async (folderId: string) => {
    try {
      await api.post('/campaigns/bulk', { ids: selected, action: 'folder', folderId });
      setFolderMenuOpen(false);
      setSelected([]);
      await Promise.all([loadCampaigns(), loadFolders()]);
    } catch (err) {
      fail(err instanceof Error ? err : new Error('移動失敗'));
    }
  };

  const deleteSelected = async () => {
    if (!window.confirm(`刪除選取的 ${selected.length} 封電子報？`)) return;
    try {
      await api.post('/campaigns/bulk', { ids: selected, action: 'delete' });
      setSelected([]);
      await Promise.all([loadCampaigns(), loadFolders()]);
    } catch (err) {
      fail(err instanceof Error ? err : new Error('刪除失敗'));
    }
  };

  return (
    <div>
        {error && <div className="notice error">{error}</div>}
        <div className="page-head">
          <h1>電子報</h1>
          <div className="page-head-actions">
            <button type="button" className="btn" onClick={() => setTemplateOpen(true)} disabled={creating}>
              透過模板新增
            </button>
            <button type="button" className="btn primary" onClick={() => void create()} disabled={creating}>
              {creating ? '建立中…' : '新增電子報'}
            </button>
          </div>
        </div>
        <CreateCampaignDialog
          open={templateOpen}
          saving={creating}
          error={error}
          onClose={() => setTemplateOpen(false)}
          onCreate={(template, title) => void createFromTemplate(template, title)}
        />
        <FolderBar
          folders={folders}
          filter={folderFilter}
          onFilter={(next) => {
            setFolderFilter(next);
            setOffset(0);
          }}
          onCreate={createFolder}
          onRename={saveRename}
          onDelete={removeFolder}
        />
        <div className="toolbar">
          <input
            type="search"
            placeholder="搜尋電子報…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setOffset(0);
            }}
          />
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setOffset(0);
            }}
            aria-label="狀態"
            style={{ width: 140 }}
          >
            <option value="">全部狀態</option>
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {STATUS_LABEL[value]}
              </option>
            ))}
          </select>
          <DateRangePicker
            from={from}
            to={to}
            onChange={(next) => {
              setFrom(next.from);
              setTo(next.to);
              setOffset(0);
            }}
          />
        </div>
        {total > 0 && (
          <div className="campaign-pager">
            <span className="muted">
              {offset + 1}–{Math.min(offset + PAGE, total)}／{total}
            </span>
            {total > PAGE && (
              <>
                <button className="btn" type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
                  上一頁
                </button>
                <button className="btn" type="button" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>
                  下一頁
                </button>
              </>
            )}
          </div>
        )}
        {items.length === 0 ? (
          <p className="muted">沒有符合條件的電子報。</p>
        ) : (
          <div className={`campaign-list ${selected.length > 0 ? 'has-bulk' : ''}`}>
            {items.map((campaign) => {
              const sent = campaign.stats?.sent ?? 0;
              const recipients = sent > 0 ? String(sent) : '—';
              const opens = metric(sent, campaign.tracking?.uniqueOpens ?? 0);
              const clicks = metric(sent, campaign.tracking?.uniqueClicks ?? 0);
              const unsubs = metric(sent, campaign.tracking?.unsubscribes ?? 0);
              const checked = selected.includes(campaign.id);
              return (
                <article className={`card campaign-card ${checked ? 'selected' : ''}`} key={campaign.id}>
                  <label className="campaign-check">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleOne(campaign.id)}
                      aria-label={`選取 ${campaign.title}`}
                    />
                  </label>
                  <div className="campaign-card-main">
                    <Link to={`/campaigns/${campaign.id}`} className="campaign-card-title">
                      {campaign.title}
                    </Link>
                    <p className="campaign-card-meta">
                      <span className={`status-dot ${campaign.status}`} />
                      <span>{STATUS_LABEL[campaign.status] ?? campaign.status}</span>
                      <span>{campaignWhen(campaign)}</span>
                    </p>
                  </div>
                  <div className="campaign-metrics">
                    <div className="campaign-metric">
                      <div className="campaign-metric-label">收件</div>
                      <div className="campaign-metric-value">{recipients}</div>
                      <div className="campaign-metric-rate">{sent > 0 ? '已寄出' : '—'}</div>
                    </div>
                    <div className="campaign-metric">
                      <div className="campaign-metric-label">開信</div>
                      <div className="campaign-metric-value">{opens.value}</div>
                      <div className="campaign-metric-rate">{opens.rate}</div>
                    </div>
                    <div className="campaign-metric">
                      <div className="campaign-metric-label">點擊</div>
                      <div className="campaign-metric-value">{clicks.value}</div>
                      <div className="campaign-metric-rate">{clicks.rate}</div>
                    </div>
                    <div className="campaign-metric">
                      <div className="campaign-metric-label">退訂</div>
                      <div className="campaign-metric-value">{unsubs.value}</div>
                      <div className="campaign-metric-rate">{unsubs.rate}</div>
                    </div>
                  </div>
                  <div className="campaign-card-more" data-campaign-menu>
                    <button
                      type="button"
                      className="icon"
                      aria-label={`${campaign.title} 的更多動作`}
                      aria-expanded={menuId === campaign.id}
                      aria-haspopup="menu"
                      onClick={() => setMenuId((current) => (current === campaign.id ? null : campaign.id))}
                    >
                      <MoreHorizontal size={16} />
                    </button>
                    {menuId === campaign.id && (
                      <div className="flow-menu" role="menu">
                        <Link to={`/campaigns/${campaign.id}`} role="menuitem" onClick={() => setMenuId(null)}>
                          編輯
                        </Link>
                        <button
                          type="button"
                          role="menuitem"
                          disabled={savingTemplateId === campaign.id}
                          onClick={() => {
                            setMenuId(null);
                            void saveAsTemplate(campaign);
                          }}
                        >
                          {savingTemplateId === campaign.id ? '儲存中…' : '存成模板'}
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          className="danger"
                          onClick={() => {
                            setMenuId(null);
                            void remove(campaign);
                          }}
                        >
                          刪除
                        </button>
                      </div>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
        {selected.length > 0 && (
          <div className="bulk-bar" role="toolbar" aria-label="選取動作">
            <span>
              {selected.length}／{items.length}
            </span>
            <button type="button" className="btn ghost" onClick={togglePage}>
              {allOnPageSelected ? '取消全選' : '全選'}
            </button>
            <div className="bulk-folder" data-bulk-folder>
              <button type="button" className="btn ghost" onClick={() => setFolderMenuOpen((open) => !open)}>
                加入資料夾
              </button>
              {folderMenuOpen && (
                <div className="flow-menu" role="menu">
                  <button type="button" role="menuitem" onClick={() => void moveSelected('')}>
                    未分類
                  </button>
                  {folders.map((folder) => (
                    <button key={folder.id} type="button" role="menuitem" onClick={() => void moveSelected(folder.id)}>
                      {folder.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button type="button" className="btn ghost danger" onClick={() => void deleteSelected()}>
              刪除選取
            </button>
          </div>
        )}
    </div>
  );
}

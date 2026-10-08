import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useOutletContext } from 'react-router-dom';
import { MoreHorizontal } from 'lucide-react';
import { api, formatRate, formatTime, STATUS_LABEL, type Campaign, type CampaignTemplate, type Folder, type Session } from '../api';
import { DateRangePicker } from '../components/DateRangePicker';
import { CreateCampaignDialog } from '../components/CreateCampaignDialog';
import { FolderBar, type FolderFilter } from '../components/FolderBar';
import { AiWriteNotice } from '../components/AiWriteNotice';
import { Modal } from '../components/Modal';

const STATUSES = ['draft', 'scheduled', 'sending', 'sent', 'failed', 'canceled'];
const PAGE = 10;

function CampaignPager({
  offset,
  total,
  onOffset,
}: {
  offset: number;
  total: number;
  onOffset: (next: number) => void;
}) {
  if (total <= PAGE) return null;
  const page = Math.floor(offset / PAGE) + 1;
  const pages = Math.ceil(total / PAGE);
  return (
    <nav className="campaign-pager" aria-label="電子報分頁">
      <button className="btn" type="button" disabled={offset === 0} onClick={() => onOffset(Math.max(0, offset - PAGE))}>
        上一頁
      </button>
      <span className="muted campaign-page" aria-current="page">
        第 {page}／{pages} 頁
      </span>
      <button className="btn" type="button" disabled={offset + PAGE >= total} onClick={() => onOffset(offset + PAGE)}>
        下一頁
      </button>
    </nav>
  );
}

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
  const session = useOutletContext<Session | null>();
  const aiOn = Boolean(session?.ai.configured);
  const [items, setItems] = useState<Campaign[]>([]);
  const [total, setTotal] = useState(0);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [folderFilter, setFolderFilter] = useState<FolderFilter>('all');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [status, setStatus] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [folderMenuOpen, setFolderMenuOpen] = useState(false);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [writing, setWriting] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [copyingId, setCopyingId] = useState<string | null>(null);
  const [aiMode, setAiMode] = useState<null | 'filter' | 'organize'>(null);
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState('');
  const [filterPreview, setFilterPreview] = useState<{
    search: string;
    status: string;
    from: string;
    to: string;
    folderId: string;
    explanation: string;
    unsupported: string;
  } | null>(null);
  const [organizePreview, setOrganizePreview] = useState<{ id: string; folderId: string | null; note: string; keep: boolean }[] | null>(null);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (debouncedSearch) params.set('search', debouncedSearch);
    if (status) params.set('status', status);
    if (from) params.set('from', new Date(from).toISOString());
    if (to) params.set('to', new Date(`${to}T23:59:59`).toISOString());
    if (folderFilter === 'unfiled') params.set('folderId', 'unfiled');
    else if (folderFilter !== 'all') params.set('folderId', folderFilter);
    params.set('limit', String(PAGE));
    params.set('offset', String(offset));
    return params.toString();
  }, [debouncedSearch, status, from, to, folderFilter, offset]);

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
      if (offset > 0 && data.items.length === 0) {
        setOffset(data.total > 0 ? Math.floor((data.total - 1) / PAGE) * PAGE : 0);
      }
    });

  useEffect(() => {
    void loadFolders().catch((err: Error) => setError(err.message));
  }, []);

  useEffect(() => {
    const handle = window.setTimeout(() => setDebouncedSearch(search), 200);
    return () => window.clearTimeout(handle);
  }, [search]);

  useEffect(() => {
    void loadCampaigns().catch((err: Error) => setError(err.message));
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
        bodyHtml: '<p>嗨 {{name}}，</p><p>這裡是這期的內容。</p>{{signature}}',
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

  const duplicate = async (campaign: Campaign) => {
    setCopyingId(campaign.id);
    setError('');
    try {
      const created = await api.post<Campaign>(`/campaigns/${campaign.id}/copy`);
      navigate(`/campaigns/${created.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : '複製失敗');
      setCopyingId(null);
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
            <button type="button" className="btn" onClick={() => setWriting(true)} disabled={creating}>
              用 AI 寫信
            </button>
            <button type="button" className="btn" onClick={() => setTemplateOpen(true)} disabled={creating}>
              透過模板新增
            </button>
            <button type="button" className="btn primary" onClick={() => void create()} disabled={creating}>
              {creating ? '建立中…' : '新增電子報'}
            </button>
          </div>
        </div>
        {writing && (
          <WriteCampaignDialog
            ai={session?.ai}
            folderId={folderId}
            onClose={() => setWriting(false)}
            onCreated={(id) => navigate(`/campaigns/${id}`)}
          />
        )}
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
          {aiOn && (
            <button type="button" className="btn" onClick={() => { setAiError(''); setFilterPreview(null); setAiMode('filter'); }}>
              用一句話篩選
            </button>
          )}
          <span className="muted campaign-count">共 {total} 封</span>
        </div>
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
                          disabled={copyingId === campaign.id}
                          onClick={() => {
                            setMenuId(null);
                            void duplicate(campaign);
                          }}
                        >
                          {copyingId === campaign.id ? '複製中…' : '複製'}
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
        <CampaignPager offset={offset} total={total} onOffset={setOffset} />
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
            {aiOn && (
              <button
                type="button"
                className="btn ghost"
                disabled={selected.length > 30}
                onClick={() => { setAiError(''); setOrganizePreview(null); setAiMode('organize'); }}
              >
                建議歸檔
              </button>
            )}
          </div>
        )}
        {aiMode === 'filter' && (
          <Modal title="用一句話篩選" onClose={() => { if (!aiBusy) setAiMode(null); }}>
            {aiError && <div className="notice error">{aiError}</div>}
            {!filterPreview ? (
              <form onSubmit={(event) => {
                event.preventDefault();
                setAiBusy(true);
                setAiError('');
                void api.post<NonNullable<typeof filterPreview>>('/ai/filter', { scope: 'campaigns', prompt: aiPrompt })
                  .then(setFilterPreview)
                  .catch((err: Error) => setAiError(err.message))
                  .finally(() => setAiBusy(false));
              }}>
                <label htmlFor="campaign-ai-filter">想看哪些信</label>
                <textarea id="campaign-ai-filter" required value={aiPrompt} onChange={(event) => setAiPrompt(event.target.value)} placeholder="例如：九月的草稿" />
                <div className="row" style={{ justifyContent: 'flex-end' }}>
                  <button className="btn primary" type="submit" disabled={aiBusy}>{aiBusy ? '理解中…' : '預覽篩選'}</button>
                </div>
              </form>
            ) : (
              <div>
                <p>{filterPreview.explanation || '已理解這句話。'}</p>
                {filterPreview.unsupported && <div className="notice">{filterPreview.unsupported}</div>}
                <div className="row" style={{ justifyContent: 'flex-end' }}>
                  <button type="button" className="btn primary" onClick={() => {
                    setSearch(filterPreview.search);
                    setStatus(filterPreview.status);
                    setFrom(filterPreview.from);
                    setTo(filterPreview.to);
                    setFolderFilter(filterPreview.folderId || 'all');
                    setOffset(0);
                    setAiMode(null);
                  }}>套用</button>
                </div>
              </div>
            )}
          </Modal>
        )}
        {aiMode === 'organize' && (
          <Modal title="建議歸檔" wide onClose={() => { if (!aiBusy) setAiMode(null); }}>
            {aiError && <div className="notice error">{aiError}</div>}
            <p className="muted">只會移到已經存在的資料夾，不會新建資料夾。</p>
            {!organizePreview ? (
              <button type="button" className="btn primary" disabled={aiBusy} onClick={() => {
                setAiBusy(true);
                setAiError('');
                void api.post<{ suggestions: { id: string; folderId: string | null; note: string }[] }>('/ai/organize-campaigns', { ids: selected.slice(0, 30) })
                  .then((result) => setOrganizePreview(result.suggestions.map((item) => ({ ...item, keep: true }))))
                  .catch((err: Error) => setAiError(err.message))
                  .finally(() => setAiBusy(false));
              }}>{aiBusy ? '整理中…' : '產生建議'}</button>
            ) : (
              <form onSubmit={(event) => {
                event.preventDefault();
                const picked = organizePreview.filter((item) => item.keep);
                const groups = new Map<string, string[]>();
                for (const item of picked) {
                  const key = item.folderId ?? '';
                  groups.set(key, [...(groups.get(key) ?? []), item.id]);
                }
                setAiBusy(true);
                void Promise.all([...groups.entries()].map(([folderId, ids]) => api.post('/campaigns/bulk', { ids, action: 'folder', folderId })))
                  .then(() => {
                    setSelected([]);
                    setAiMode(null);
                    return Promise.all([loadCampaigns(), loadFolders()]);
                  })
                  .catch((err: Error) => setAiError(err.message))
                  .finally(() => setAiBusy(false));
              }}>
                <table className="data">
                  <thead><tr><th>套用</th><th>電子報</th><th>資料夾</th><th>說明</th></tr></thead>
                  <tbody>
                    {organizePreview.map((item) => (
                      <tr key={item.id}>
                        <td><input type="checkbox" checked={item.keep} aria-label="套用這列" onChange={() => setOrganizePreview((current) => current?.map((row) => row.id === item.id ? { ...row, keep: !row.keep } : row) ?? current)} /></td>
                        <td>{items.find((campaign) => campaign.id === item.id)?.title ?? item.id}</td>
                        <td>{item.folderId ? (folders.find((folder) => folder.id === item.folderId)?.name ?? '資料夾') : '未分類'}</td>
                        <td className="muted">{item.note || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="row" style={{ justifyContent: 'flex-end' }}>
                  <button className="btn primary" type="submit" disabled={aiBusy}>{aiBusy ? '套用中…' : '套用勾選'}</button>
                </div>
              </form>
            )}
          </Modal>
        )}
    </div>
  );
}

function WriteCampaignDialog({
  ai,
  folderId,
  onClose,
  onCreated,
}: {
  ai: Session['ai'] | undefined;
  folderId?: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const canWrite = Boolean(ai?.writes);
  const [brief, setBrief] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<{ title: string; preheader: string; bodyHtml: string } | null>(null);

  return (
    <Modal title="用 AI 寫信" wide onClose={() => { if (!busy) onClose(); }}>
      {error && <div className="notice error">{error}</div>}
      <AiWriteNotice ai={ai} />
      {!draft ? (
        <form onSubmit={(event) => {
          event.preventDefault();
          if (!canWrite) return;
          setBusy(true);
          setError('');
          void api.post<NonNullable<typeof draft>>('/ai/draft', { brief })
            .then(setDraft)
            .catch((err: Error) => setError(err.message))
            .finally(() => setBusy(false));
        }}>
          <label htmlFor="ai-brief">想寫的內容</label>
          <textarea
            id="ai-brief"
            required
            autoFocus={canWrite}
            disabled={!canWrite}
            value={brief}
            onChange={(event) => setBrief(event.target.value)}
            placeholder="這封信要跟讀者說什麼"
          />
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn primary" type="submit" disabled={busy || !canWrite}>{busy ? '產生中…' : '產生預覽'}</button>
          </div>
        </form>
      ) : (
        <div>
          <p><strong>{draft.title}</strong></p>
          <p className="muted">{draft.preheader || '（沒有前導文字）'}</p>
          <div className="ai-html" dangerouslySetInnerHTML={{ __html: draft.bodyHtml }} />
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn" onClick={() => setDraft(null)}>重寫</button>
            <button
              type="button"
              className="btn primary"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setError('');
                void api.post<Campaign>('/campaigns', {
                  title: draft.title,
                  subject: draft.title,
                  preheader: draft.preheader,
                  bodyHtml: draft.bodyHtml,
                  folderId,
                })
                  .then((created) => onCreated(created.id))
                  .catch((err: Error) => {
                    setError(err.message);
                    setBusy(false);
                  });
              }}
            >
              {busy ? '建立中…' : '建立草稿'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

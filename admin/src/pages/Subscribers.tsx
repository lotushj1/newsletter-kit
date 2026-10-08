import { useEffect, useState, type ReactNode } from 'react';
import { useOutletContext } from 'react-router-dom';
import { MoreHorizontal, Plus, Upload, X } from 'lucide-react';
import { api, formatTime, STATUS_LABEL, type Folder, type Session, type Subscriber } from '../api';
import { FolderBar, type FolderFilter } from '../components/FolderBar';
import { Modal } from '../components/Modal';
import { ModalClose } from '../components/ModalClose';
import { SmartSubscriberSearch } from '../components/SmartSubscriberSearch';
import type { SubscriberSearchSuggestion } from '../components/subscriber-search';

const SUBSCRIBER_STATUSES = ['subscribed', 'pending', 'unsubscribed', 'bounced'] as const;

type TagEditor =
  | { mode: 'subscriber'; id: string; selected: string[] }
  | { mode: 'draft'; selected: string[] };

export function Subscribers() {
  const session = useOutletContext<Session | null>();
  const aiOn = Boolean(session?.ai.configured);
  const [items, setItems] = useState<Subscriber[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [knownTags, setKnownTags] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [tag, setTag] = useState('');
  const [folderFilter, setFolderFilter] = useState<FolderFilter>('all');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [editStatus, setEditStatus] = useState<(typeof SUBSCRIBER_STATUSES)[number]>('subscribed');
  const [addTags, setAddTags] = useState<string[]>([]);
  const [addFolder, setAddFolder] = useState('');
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importFolder, setImportFolder] = useState('');
  const [dialog, setDialog] = useState<null | 'add' | 'import' | 'edit'>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [tagEditor, setTagEditor] = useState<TagEditor | null>(null);
  const [dialogError, setDialogError] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [aiMode, setAiMode] = useState<null | 'organize'>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState('');
  const [aiNote, setAiNote] = useState<{ text: string; unsupported: string } | null>(null);
  const [organizePreview, setOrganizePreview] = useState<{
    id: string;
    tags: string[];
    folderId: string | null;
    note: string;
    keep: boolean;
  }[] | null>(null);
  const limit = 100;

  const rememberTags = (tags: string[]) => {
    setKnownTags((current) => mergeTags(current, tags));
  };

  const loadFolders = () =>
    api
      .get<{ items: Folder[]; unfiled: number; total: number }>('/folders')
      .then((data) => {
        setFolders(data.items);
      });

  const loadTags = () =>
    api.get<{ items: string[] }>('/subscribers/tags').then((data) => {
      rememberTags(data.items);
    });

  const load = () => {
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (search) params.set('search', search);
    if (status) params.set('status', status);
    if (tag) params.set('tag', tag);
    if (folderFilter === 'unfiled') params.set('folderId', 'unfiled');
    else if (folderFilter !== 'all') params.set('folderId', folderFilter);
    void api
      .get<{ items: Subscriber[]; total: number }>(`/subscribers?${params}`)
      .then((data) => {
        setItems(data.items);
        setTotal(data.total);
        rememberTags(data.items.flatMap((item) => item.tags));
        setSelected((current) => current.filter((id) => data.items.some((item) => item.id === id)));
        if (offset > 0 && data.items.length === 0) {
          setOffset(data.total > 0 ? Math.floor((data.total - 1) / limit) * limit : 0);
        }
      });
  };

  useEffect(() => {
    void loadFolders();
    void loadTags();
  }, []);

  useEffect(load, [search, status, tag, folderFilter, offset]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearch((current) => (current === query ? current : query));
    }, 200);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!menuId) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest('[data-subscriber-menu]')) return;
      setMenuId(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuId(null);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuId]);

  const refresh = () => {
    load();
    void loadFolders();
    void loadTags();
  };

  const fail = (err: Error) => setMessage(err.message);

  const createFolder = async (name: string) => {
    try {
      await api.post<Folder>('/folders', { name });
      setMessage(`已建立資料夾「${name}」`);
      await loadFolders();
    } catch (err) {
      fail(err instanceof Error ? err : new Error('建立失敗'));
      throw err;
    }
  };

  const saveRename = async (id: string, name: string) => {
    try {
      await api.patch(`/folders/${id}`, { name });
      await loadFolders();
    } catch (err) {
      fail(err instanceof Error ? err : new Error('重新命名失敗'));
      throw err;
    }
  };

  const removeFolder = (folder: Folder) => {
    if (!window.confirm(`刪除「${folder.name}」？裡面的人會回到未分類，不會被刪除。`)) return;
    void api
      .delete(`/folders/${folder.id}`)
      .then(() => {
        if (folderFilter === folder.id) setFolderFilter('all');
        setMessage('已刪除資料夾');
        refresh();
      })
      .catch(fail);
  };

  const openDialog = (next: 'add' | 'import') => {
    setDialogError('');
    setSaving(false);
    setTagEditor(null);
    setMenuId(null);
    setEditingId(null);
    if (next === 'add') {
      setEmail('');
      setName('');
      setAddTags([]);
      setAddFolder('');
    } else {
      setImportFile(null);
      setImportFolder('');
    }
    setDialog(next);
  };

  const openEdit = (subscriber: Subscriber) => {
    setDialogError('');
    setSaving(false);
    setTagEditor(null);
    setMenuId(null);
    setEditingId(subscriber.id);
    setEmail(subscriber.email);
    setName(subscriber.name ?? '');
    setEditStatus(
      SUBSCRIBER_STATUSES.includes(subscriber.status as (typeof SUBSCRIBER_STATUSES)[number])
        ? (subscriber.status as (typeof SUBSCRIBER_STATUSES)[number])
        : 'subscribed',
    );
    setAddTags(subscriber.tags);
    setAddFolder(subscriber.folderId ?? '');
    setDialog('edit');
  };

  const addSubscriber = async () => {
    setDialogError('');
    setSaving(true);
    try {
      await api.post('/subscribers', {
        email,
        name: name.trim() || undefined,
        status: 'subscribed',
        tags: addTags,
        folderId: addFolder || undefined,
      });
      setDialog(null);
      setMessage('已加入名單');
      rememberTags(addTags);
      refresh();
    } catch (err) {
      setDialogError(err instanceof Error ? err.message : '加入失敗');
      setSaving(false);
    }
  };

  const importCsv = async () => {
    if (!importFile) {
      setDialogError('請先選擇 CSV 或 Excel 檔案');
      return;
    }
    setDialogError('');
    setSaving(true);
    try {
      const result = await api.post<{ created: number; updated: number }>('/subscribers/import', {
        fileName: importFile.name,
        fileBase64: await fileToBase64(importFile),
        folderId: importFolder || undefined,
      });
      setDialog(null);
      setMessage(`匯入完成：新增 ${result.created}、更新 ${result.updated}`);
      refresh();
    } catch (err) {
      setDialogError(err instanceof Error ? err.message : '匯入失敗');
      setSaving(false);
    }
  };

  const saveEdit = async () => {
    if (!editingId) return;
    setDialogError('');
    setSaving(true);
    try {
      await api.patch(`/subscribers/${editingId}`, {
        email,
        name,
        status: editStatus,
        tags: addTags,
        folderId: addFolder,
      });
      setDialog(null);
      setEditingId(null);
      setMessage('已更新名單');
      rememberTags(addTags);
      refresh();
    } catch (err) {
      setDialogError(err instanceof Error ? err.message : '更新失敗');
      setSaving(false);
    }
  };

  const removeSubscriber = (subscriber: Subscriber) => {
    setMenuId(null);
    if (!window.confirm(`刪除「${subscriber.email}」？刪除後無法復原。`)) return;
    void api
      .delete(`/subscribers/${subscriber.id}`)
      .then(() => {
        if (editingId === subscriber.id) {
          setDialog(null);
          setEditingId(null);
        }
        setMessage('已從名單刪除');
        refresh();
      })
      .catch(fail);
  };

  const patchSubscriber = (id: string, body: Record<string, unknown>) => {
    void api
      .patch<Subscriber>(`/subscribers/${id}`, body)
      .then((updated) => {
        setItems((current) => current.map((row) => (row.id === id ? updated : row)));
        if (Array.isArray(updated.tags)) rememberTags(updated.tags);
        void loadFolders();
      })
      .catch(fail);
  };

  const saveTagEditor = (next: string[]) => {
    if (!tagEditor) return;
    rememberTags(next);
    if (tagEditor.mode === 'subscriber') patchSubscriber(tagEditor.id, { tags: next });
    else setAddTags(next);
    setTagEditor(null);
  };

  const clearQuery = () => {
    setQuery('');
    setSearch('');
    setOffset(0);
  };

  const applySearchSuggestion = (item: SubscriberSearchSuggestion) => {
    setAiNote(null);
    setAiError('');
    if (item.kind === 'search') {
      setQuery(item.search);
      setSearch(item.search);
      setOffset(0);
      return;
    }
    clearQuery();
    if (item.kind === 'status') setStatus(item.status);
    if (item.kind === 'tag') setTag(item.tag);
    if (item.kind === 'folder') setFolderFilter(item.folderId);
  };

  const askSubscriberSearch = async (prompt: string): Promise<boolean> => {
    setAiError('');
    setAiBusy(true);
    try {
      const result = await api.post<{
        search: string;
        status: string;
        tag: string;
        folderId: string;
        explanation: string;
        unsupported: string;
      }>('/ai/filter', { scope: 'subscribers', prompt });
      setSearch(result.search);
      setQuery(result.search);
      setStatus(result.status);
      setTag(result.tag);
      if (result.folderId) setFolderFilter(result.folderId);
      setOffset(0);
      const summary = [
        result.search ? `搜尋「${result.search}」` : '',
        result.status ? (STATUS_LABEL[result.status] ?? result.status) : '',
        result.tag ? `標籤 ${result.tag}` : '',
        result.folderId === 'unfiled'
          ? '未分類'
          : result.folderId
            ? (folders.find((folder) => folder.id === result.folderId)?.name ?? '')
            : '',
      ].filter(Boolean).join(' · ');
      setAiNote({
        text: result.explanation || summary || '這句話沒有對上可以篩的條件。',
        unsupported: result.unsupported,
      });
      return true;
    } catch (err) {
      setAiError(err instanceof Error ? err.message : '無法理解這句話');
      return false;
    } finally {
      setAiBusy(false);
    }
  };

  const filterOptions = tag && !knownTags.includes(tag) ? [tag, ...knownTags] : knownTags;

  return (
    <div>
        {message && <div className="notice">{message}</div>}
        <div className="page-head">
          <h1>名單</h1>
          <div className="row">
            <button type="button" className="btn" onClick={() => openDialog('import')}>
              匯入
            </button>
            <button type="button" className="btn primary" onClick={() => openDialog('add')}>
              手動新增
            </button>
            <a className="btn" href="/api/admin/subscribers/export.csv">
              匯出 CSV
            </a>
          </div>
        </div>
        <FolderBar
          folders={folders}
          filter={folderFilter}
          onFilter={(next) => {
            setFolderFilter(next);
            setOffset(0);
            setAiNote(null);
          }}
          onCreate={createFolder}
          onRename={saveRename}
          onDelete={removeFolder}
        />
        <div className="toolbar">
          <SmartSubscriberSearch
            value={query}
            tags={knownTags}
            folders={folders}
            ai={aiOn}
            busy={aiBusy && aiMode !== 'organize'}
            onChange={(value) => {
              setQuery(value);
              setOffset(0);
              setAiNote(null);
            }}
            onApply={applySearchSuggestion}
            onAskAi={askSubscriberSearch}
          />
          <select value={tag} onChange={(e) => { setTag(e.target.value); setOffset(0); setAiNote(null); }} aria-label="篩選標籤" style={{ width: 140 }}>
            <option value="">全部標籤</option>
            {filterOptions.map((item) => (
              <option key={item} value={item}>{item}</option>
            ))}
          </select>
          <select value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); setAiNote(null); }} aria-label="篩選狀態" style={{ width: 140 }}>
            <option value="">全部狀態</option>
            <option value="subscribed">已訂閱</option>
            <option value="pending">待確認</option>
            <option value="unsubscribed">已退訂</option>
            <option value="bounced">退信</option>
          </select>
          {aiOn && (
            <button
              type="button"
              className="btn"
              disabled={selected.length === 0 || selected.length > 30}
              onClick={() => { setAiError(''); setOrganizePreview(null); setAiMode('organize'); }}
            >
              建議整理
            </button>
          )}
        </div>
        {aiError && aiMode !== 'organize' && <div className="notice error">{aiError}</div>}
        {aiNote && (
          <div className={aiNote.unsupported ? 'notice warn' : 'notice'}>
            {aiNote.text}
            {aiNote.unsupported ? `。${aiNote.unsupported}` : ''}
          </div>
        )}
        {dialog === 'add' && (
          <FormDialog title="手動新增" onClose={() => setDialog(null)} ignoreEscape={!!tagEditor}>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void addSubscriber();
              }}
            >
              {dialogError && <div className="notice error">{dialogError}</div>}
              <label htmlFor="subscriber-email">Email</label>
              <input
                id="subscriber-email"
                type="email"
                required
                autoFocus
                placeholder="reader@example.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
              <label htmlFor="subscriber-name">名稱</label>
              <input
                id="subscriber-name"
                type="text"
                placeholder="選填"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
              <label id="subscriber-tags-label">標籤</label>
              <TagPills
                tags={addTags}
                labelledBy="subscriber-tags-label"
                onAdd={() => setTagEditor({ mode: 'draft', selected: addTags })}
                onRemove={(item) => setAddTags((current) => current.filter((tag) => tag !== item))}
              />
              <label htmlFor="subscriber-folder">資料夾</label>
              <select id="subscriber-folder" value={addFolder} onChange={(event) => setAddFolder(event.target.value)}>
                <option value="">未分類</option>
                {folders.map((folder) => (
                  <option key={folder.id} value={folder.id}>{folder.name}</option>
                ))}
              </select>
              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <button className="btn primary" type="submit" disabled={saving}>
                  {saving ? '加入中…' : '加入'}
                </button>
              </div>
            </form>
          </FormDialog>
        )}
        {dialog === 'edit' && (
          <FormDialog title="編輯名單" onClose={() => setDialog(null)} ignoreEscape={!!tagEditor}>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void saveEdit();
              }}
            >
              {dialogError && <div className="notice error">{dialogError}</div>}
              <label htmlFor="subscriber-edit-email">Email</label>
              <input
                id="subscriber-edit-email"
                type="email"
                required
                autoFocus
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
              <label htmlFor="subscriber-edit-name">名稱</label>
              <input
                id="subscriber-edit-name"
                type="text"
                placeholder="選填"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
              <label htmlFor="subscriber-edit-status">狀態</label>
              <select
                id="subscriber-edit-status"
                value={editStatus}
                onChange={(event) => setEditStatus(event.target.value as (typeof SUBSCRIBER_STATUSES)[number])}
              >
                {SUBSCRIBER_STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {STATUS_LABEL[value] ?? value}
                  </option>
                ))}
              </select>
              <label id="subscriber-edit-tags-label">標籤</label>
              <TagPills
                tags={addTags}
                labelledBy="subscriber-edit-tags-label"
                onAdd={() => setTagEditor({ mode: 'draft', selected: addTags })}
                onRemove={(item) => setAddTags((current) => current.filter((tag) => tag !== item))}
              />
              <label htmlFor="subscriber-edit-folder">資料夾</label>
              <select
                id="subscriber-edit-folder"
                value={addFolder}
                onChange={(event) => setAddFolder(event.target.value)}
              >
                <option value="">未分類</option>
                {folders.map((folder) => (
                  <option key={folder.id} value={folder.id}>{folder.name}</option>
                ))}
              </select>
              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <button className="btn primary" type="submit" disabled={saving}>
                  {saving ? '儲存中…' : '儲存'}
                </button>
              </div>
            </form>
          </FormDialog>
        )}
        {dialog === 'import' && (
          <FormDialog title="匯入" onClose={() => setDialog(null)}>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void importCsv();
              }}
            >
              {dialogError && <div className="notice error">{dialogError}</div>}
              <label className="file-drop" htmlFor="subscriber-file">
                <input
                  id="subscriber-file"
                  type="file"
                  accept=".csv,.xls,.xlsx,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  onChange={(event) => setImportFile(event.target.files?.[0] ?? null)}
                />
                <Upload className="file-drop-icon" size={24} strokeWidth={1.75} aria-hidden />
                {importFile && <span className="file-drop-name">{importFile.name}</span>}
                <span className="muted">支援 CSV、XLS、XLSX</span>
                <span className="muted">第一列請依照 email、name、tags 建立</span>
              </label>
              <label htmlFor="subscriber-import-folder">資料夾</label>
              <select
                id="subscriber-import-folder"
                value={importFolder}
                onChange={(event) => setImportFolder(event.target.value)}
              >
                <option value="">未分類</option>
                {folders.map((folder) => (
                  <option key={folder.id} value={folder.id}>{folder.name}</option>
                ))}
              </select>
              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <button className="btn primary" type="submit" disabled={saving || !importFile}>
                  {saving ? '匯入中…' : '匯入'}
                </button>
              </div>
            </form>
          </FormDialog>
        )}
        {tagEditor && (
          <TagEditorDialog
            knownTags={knownTags}
            selected={tagEditor.selected}
            onClose={() => setTagEditor(null)}
            onSave={saveTagEditor}
          />
        )}
        <table className="data">
          <thead>
            <tr>
              {aiOn && (
                <th className="check">
                  <input
                    type="checkbox"
                    aria-label="選取此頁"
                    checked={items.length > 0 && items.every((item) => selected.includes(item.id))}
                    onChange={() => {
                      const ids = items.map((item) => item.id);
                      const all = ids.every((id) => selected.includes(id));
                      setSelected(all ? selected.filter((id) => !ids.includes(id)) : [...new Set([...selected, ...ids])]);
                    }}
                  />
                </th>
              )}
              <th>Email</th>
              <th>名稱</th>
              <th>狀態</th>
              <th>資料夾</th>
              <th>標籤</th>
              <th>加入時間</th>
              <th className="actions">動作</th>
            </tr>
          </thead>
          <tbody>
            {items.map((s) => (
              <tr key={s.id}>
                {aiOn && (
                  <td className="check">
                    <input
                      type="checkbox"
                      aria-label={`選取 ${s.email}`}
                      checked={selected.includes(s.id)}
                      onChange={() => setSelected((current) => current.includes(s.id) ? current.filter((id) => id !== s.id) : [...current, s.id])}
                    />
                  </td>
                )}
                <td>{s.email}</td>
                <td>{s.name ?? '—'}</td>
                <td><span className={`pill ${s.status}`}>{STATUS_LABEL[s.status] ?? s.status}</span></td>
                <td>
                  <select
                    value={s.folderId ?? ''}
                    onChange={(e) => patchSubscriber(s.id, { folderId: e.target.value })}
                    style={{ width: 140 }}
                  >
                    <option value="">未分類</option>
                    {folders.map((folder) => (
                      <option key={folder.id} value={folder.id}>{folder.name}</option>
                    ))}
                  </select>
                </td>
                <td>
                  <TagPills
                    tags={s.tags}
                    onAdd={() => setTagEditor({ mode: 'subscriber', id: s.id, selected: s.tags })}
                    onRemove={(item) =>
                      patchSubscriber(s.id, { tags: s.tags.filter((tag) => tag !== item) })
                    }
                  />
                </td>
                <td className="muted">{formatTime(s.createdAt)}</td>
                <td className="actions">
                  <div className="subscriber-more" data-subscriber-menu>
                    <button
                      type="button"
                      className="icon"
                      aria-label={`${s.email} 的更多動作`}
                      aria-expanded={menuId === s.id}
                      aria-haspopup="menu"
                      onClick={() => setMenuId((current) => (current === s.id ? null : s.id))}
                    >
                      <MoreHorizontal size={16} />
                    </button>
                    {menuId === s.id && (
                      <div className="flow-menu" role="menu">
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => openEdit(s)}
                        >
                          編輯
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          className="danger"
                          onClick={() => removeSubscriber(s)}
                        >
                          刪除
                        </button>
                      </div>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {total > limit && (
          <div className="toolbar" style={{ marginTop: 12 }}>
            <button className="btn" type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>上一頁</button>
            <span className="muted">{offset + 1}–{Math.min(offset + limit, total)} / {total}</span>
            <button className="btn" type="button" disabled={offset + limit >= total} onClick={() => setOffset(offset + limit)}>下一頁</button>
          </div>
        )}
        {aiMode === 'organize' && (
          <Modal title="建議整理" wide onClose={() => { if (!aiBusy) setAiMode(null); }}>
            {aiError && <div className="notice error">{aiError}</div>}
            <p className="muted">只會改標籤和資料夾，不會改 Email 或狀態。一次最多 30 人。</p>
            {!organizePreview ? (
              <button type="button" className="btn primary" disabled={aiBusy} onClick={() => {
                setAiError('');
                setAiBusy(true);
                void api.post<{ suggestions: { id: string; tags?: string[]; folderId: string | null; note: string }[] }>('/ai/organize-subscribers', { ids: selected.slice(0, 30) })
                  .then((result) => setOrganizePreview(result.suggestions.map((item) => ({
                    id: item.id,
                    tags: item.tags ?? [],
                    folderId: item.folderId,
                    note: item.note,
                    keep: true,
                  }))))
                  .catch((err: Error) => setAiError(err.message))
                  .finally(() => setAiBusy(false));
              }}>{aiBusy ? '整理中…' : `為選取的 ${Math.min(selected.length, 30)} 人產生建議`}</button>
            ) : (
              <form onSubmit={(event) => {
                event.preventDefault();
                const picked = organizePreview.filter((item) => item.keep);
                setAiBusy(true);
                void Promise.all(picked.map((item) => api.patch(`/subscribers/${item.id}`, {
                  tags: item.tags,
                  folderId: item.folderId ?? '',
                })))
                  .then(() => {
                    setMessage(`已更新 ${picked.length} 人`);
                    setAiMode(null);
                    setSelected([]);
                    refresh();
                  })
                  .catch((err: Error) => setAiError(err.message))
                  .finally(() => setAiBusy(false));
              }}>
                <table className="data">
                  <thead>
                    <tr><th>套用</th><th>對象</th><th>建議標籤</th><th>建議資料夾</th><th>說明</th></tr>
                  </thead>
                  <tbody>
                    {organizePreview.map((item) => {
                      const person = items.find((row) => row.id === item.id);
                      return (
                        <tr key={item.id}>
                          <td><input type="checkbox" checked={item.keep} aria-label={`套用 ${person?.email ?? item.id}`} onChange={() => setOrganizePreview((current) => current?.map((row) => row.id === item.id ? { ...row, keep: !row.keep } : row) ?? current)} /></td>
                          <td>{person?.name || person?.email || item.id}</td>
                          <td>{item.tags.join(', ') || '—'}</td>
                          <td>{item.folderId ? (folders.find((folder) => folder.id === item.folderId)?.name ?? '資料夾') : '未分類'}</td>
                          <td className="muted">{item.note || '—'}</td>
                        </tr>
                      );
                    })}
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

function TagPills({
  tags,
  labelledBy,
  onAdd,
  onRemove,
}: {
  tags: string[];
  labelledBy?: string;
  onAdd: () => void;
  onRemove: (tag: string) => void;
}) {
  return (
    <div className="tag-cell" role="group" aria-labelledby={labelledBy}>
      {tags.map((item) => (
        <span key={item} className="tag-chip">
          {item}
          <button type="button" aria-label={`移除 ${item}`} onClick={() => onRemove(item)}>
            <X size={12} />
          </button>
        </span>
      ))}
      <button type="button" className="tag-add" aria-label="設定標籤" onClick={onAdd}>
        <Plus size={14} />
      </button>
    </div>
  );
}

function TagEditorDialog({
  knownTags,
  selected,
  onClose,
  onSave,
}: {
  knownTags: string[];
  selected: string[];
  onClose: () => void;
  onSave: (tags: string[]) => void;
}) {
  const [picked, setPicked] = useState(selected);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const options = mergeTags(knownTags, picked);

  const addDraft = () => {
    const next = normalizeClientTag(draft);
    if (!next) {
      setError('請輸入標籤名稱');
      return;
    }
    if (picked.length >= 20 && !picked.includes(next)) {
      setError('每位最多 20 個標籤');
      return;
    }
    setPicked((current) => (current.includes(next) ? current : [...current, next]));
    setDraft('');
    setError('');
  };

  const toggle = (item: string) => {
    setPicked((current) =>
      current.includes(item) ? current.filter((tag) => tag !== item) : [...current, item],
    );
    setError('');
  };

  return (
    <FormDialog title="設定標籤" titleId="tag-dialog-title" onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSave(picked);
        }}
      >
        {error && <div className="notice error">{error}</div>}
        {options.length > 0 ? (
          <div className="tag-options">
            {options.map((item) => (
              <label key={item} className="tag-option">
                <input
                  type="checkbox"
                  checked={picked.includes(item)}
                  onChange={() => toggle(item)}
                />
                {item}
              </label>
            ))}
          </div>
        ) : (
          <p className="muted tag-empty">還沒有標籤。在下面輸入名稱後按加入。</p>
        )}
        <label htmlFor="tag-new">新增標籤</label>
        <div className="row">
          <input
            id="tag-new"
            className="grow"
            autoFocus={options.length === 0}
            placeholder="例如 vip"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                addDraft();
              }
            }}
          />
          <button type="button" className="btn" onClick={addDraft}>
            加入
          </button>
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn primary" type="submit">
            儲存
          </button>
        </div>
      </form>
    </FormDialog>
  );
}

function mergeTags(...lists: string[][]): string[] {
  return [...new Set(lists.flat().map((tag) => tag.trim().toLowerCase()).filter(Boolean))].sort();
}

function normalizeClientTag(value: string): string {
  const tag = value.trim().toLowerCase();
  return tag.length > 0 && tag.length <= 50 ? tag : '';
}

async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

function FormDialog({
  title,
  titleId = 'form-dialog-title',
  ignoreEscape = false,
  onClose,
  children,
}: {
  title: string;
  titleId?: string;
  ignoreEscape?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !ignoreEscape) onClose();
    };
    window.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [ignoreEscape, onClose]);

  return (
    <div className="modal-root" role="presentation">
      <button type="button" className="modal-backdrop" aria-label="關閉" onClick={onClose} />
      <div className="modal-panel compact" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="modal-header">
          <h2 id={titleId}>{title}</h2>
          <ModalClose onClick={onClose} />
        </header>
        <div className="modal-body form">{children}</div>
      </div>
    </div>
  );
}

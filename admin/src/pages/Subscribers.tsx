import { useEffect, useState, type ReactNode } from 'react';
import { Plus, Upload, X } from 'lucide-react';
import { api, formatTime, STATUS_LABEL, type Folder, type Subscriber } from '../api';
import { FolderBar, type FolderFilter } from '../components/FolderBar';
import { ModalClose } from '../components/ModalClose';

type TagEditor =
  | { mode: 'subscriber'; id: string; selected: string[] }
  | { mode: 'draft'; selected: string[] };

export function Subscribers() {
  const [items, setItems] = useState<Subscriber[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [knownTags, setKnownTags] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [tag, setTag] = useState('');
  const [folderFilter, setFolderFilter] = useState<FolderFilter>('all');
  const [email, setEmail] = useState('');
  const [addTags, setAddTags] = useState<string[]>([]);
  const [addFolder, setAddFolder] = useState('');
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importFolder, setImportFolder] = useState('');
  const [dialog, setDialog] = useState<null | 'add' | 'import'>(null);
  const [tagEditor, setTagEditor] = useState<TagEditor | null>(null);
  const [dialogError, setDialogError] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [offset, setOffset] = useState(0);
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
      });
  };

  useEffect(() => {
    void loadFolders();
    void loadTags();
  }, []);

  useEffect(load, [search, status, tag, folderFilter, offset]);

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
    if (next === 'add') {
      setEmail('');
      setAddTags([]);
      setAddFolder('');
    } else {
      setImportFile(null);
      setImportFolder('');
    }
    setDialog(next);
  };

  const addSubscriber = async () => {
    setDialogError('');
    setSaving(true);
    try {
      await api.post('/subscribers', {
        email,
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
          }}
          onCreate={createFolder}
          onRename={saveRename}
          onDelete={removeFolder}
        />
        <div className="toolbar">
          <input className="toolbar-search" type="search" placeholder="搜尋 Email 或名稱" value={search} onChange={(e) => { setSearch(e.target.value); setOffset(0); }} />
          <select value={tag} onChange={(e) => { setTag(e.target.value); setOffset(0); }} aria-label="篩選標籤" style={{ width: 140 }}>
            <option value="">全部標籤</option>
            {filterOptions.map((item) => (
              <option key={item} value={item}>{item}</option>
            ))}
          </select>
          <select value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }} style={{ width: 140 }}>
            <option value="">全部狀態</option>
            <option value="subscribed">已訂閱</option>
            <option value="pending">待確認</option>
            <option value="unsubscribed">已退訂</option>
          </select>
        </div>
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
              <th>Email</th>
              <th>名稱</th>
              <th>狀態</th>
              <th>資料夾</th>
              <th>標籤</th>
              <th>加入時間</th>
            </tr>
          </thead>
          <tbody>
            {items.map((s) => (
              <tr key={s.id}>
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

import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useOutletContext } from 'react-router-dom';
import { MoreHorizontal } from 'lucide-react';
import {
  AUTOMATION_TEMPLATES,
  TRIGGER_META,
  cloneTemplateNodes,
  nodeLabel,
  sequencePayloadFromNodes,
  type AutomationTemplate,
  type FlowNode,
} from '../automation';
import { api, formatTime, type Campaign, type Folder, type Sequence, type Session } from '../api';
import { CampaignSelect } from '../components/CampaignSelect';
import { AiWriteNotice } from '../components/AiWriteNotice';
import { Modal } from '../components/Modal';
import { ModalClose } from '../components/ModalClose';
import { Switch } from '../components/Switch';

type Filter = 'all' | 'active' | 'inactive';

export function Sequences() {
  const navigate = useNavigate();
  const session = useOutletContext<Session | null>();
  const ai = session?.ai;
  const [items, setItems] = useState<Sequence[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [copyingId, setCopyingId] = useState<string | null>(null);

  const load = () => {
    void api
      .get<{ items: Sequence[] }>('/sequences')
      .then((data) => setItems(data.items))
      .catch((err: Error) => setError(err.message));
    void api.get<{ items: Folder[] }>('/folders').then((data) => setFolders(data.items));
    void api.get<{ items: Campaign[] }>('/campaigns?limit=100').then((data) => setCampaigns(data.items));
  };

  useEffect(load, []);

  useEffect(() => {
    if (!menuId) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest('[data-sequence-menu]')) return;
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

  const counts = useMemo(
    () => ({
      all: items.length,
      active: items.filter((item) => item.enabled).length,
      inactive: items.filter((item) => !item.enabled).length,
    }),
    [items],
  );

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return items.filter((item) => {
      if (filter === 'active' && !item.enabled) return false;
      if (filter === 'inactive' && item.enabled) return false;
      if (!query) return true;
      return item.name.toLowerCase().includes(query);
    });
  }, [items, filter, search]);

  const triggerText = (item: Sequence) => {
    const meta = TRIGGER_META[item.trigger] ?? TRIGGER_META.subscribe;
    if (item.trigger === 'folder') {
      const folder = folders.find((entry) => entry.id === item.triggerValue);
      return folder ? `${meta.label} · ${folder.name}` : meta.label;
    }
    if (item.trigger === 'open' || item.trigger === 'click') {
      const campaign = campaigns.find((entry) => entry.id === item.triggerValue);
      return campaign ? `${meta.label} · ${campaign.title}` : meta.label;
    }
    return item.triggerValue ? `${meta.label} · ${item.triggerValue}` : meta.label;
  };

  const toggle = async (item: Sequence) => {
    setError('');
    try {
      await api.patch(`/sequences/${item.id}`, { enabled: !item.enabled });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '更新失敗');
    }
  };

  const remove = async (item: Sequence) => {
    if (!window.confirm(`刪除「${item.name}」？進行中的入隊也會一併消失。`)) return;
    await api.delete(`/sequences/${item.id}`);
    load();
  };

  const duplicate = async (item: Sequence) => {
    setCopyingId(item.id);
    setError('');
    try {
      const created = await api.post<Sequence>(`/sequences/${item.id}/copy`);
      navigate(`/sequences/${created.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : '複製失敗');
      setCopyingId(null);
    }
  };

  return (
    <div>
      {error && <div className="notice error">{error}</div>}
      <div className="page-head">
        <h1>自動化</h1>
        <div className="page-head-actions">
          <button type="button" className="btn" onClick={() => setDrafting(true)}>
            用 AI 建立
          </button>
          <button type="button" className="btn primary" onClick={() => setCreating(true)}>
            建立自動化
          </button>
        </div>
      </div>
      <div className="toolbar">
        <div className="pills">
          {(
            [
              ['all', `全部 ${counts.all}`],
              ['active', `啟用 ${counts.active}`],
              ['inactive', `停用 ${counts.inactive}`],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`pill ${filter === value ? 'active' : ''}`}
              onClick={() => setFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <input
          type="search"
          placeholder="搜尋自動化…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      {visible.length === 0 ? (
        <p className="muted">{items.length === 0 ? '還沒有自動化。用一句話建立，或從模板開始。' : '沒有符合條件的自動化。'}</p>
      ) : (
        <div className="auto-list">
          {visible.map((item) => (
            <article className="card auto-card" key={item.id}>
              <div className="auto-card-main">
                <Link to={`/sequences/${item.id}`} className="auto-card-title">
                  {item.name}
                </Link>
                <p className="muted">
                  {triggerText(item)} · 上次編輯 {formatTime(item.updatedAt ?? item.createdAt)}
                </p>
              </div>
              <div className="auto-card-stats">
                <div>
                  <strong>{item.stats?.active ?? 0}</strong>
                  <span className="muted">進行中</span>
                </div>
                <div>
                  <strong>{item.stats?.completed ?? 0}</strong>
                  <span className="muted">已完成</span>
                </div>
                <div>
                  <strong>{item.stats?.canceled ?? 0}</strong>
                  <span className="muted">已取消</span>
                </div>
              </div>
              <div className="auto-card-actions">
                <Switch checked={item.enabled} onChange={() => void toggle(item)} />
                <div className="campaign-card-more" data-sequence-menu>
                  <button
                    type="button"
                    className="icon"
                    aria-label={`${item.name} 的更多動作`}
                    aria-expanded={menuId === item.id}
                    aria-haspopup="menu"
                    onClick={() => setMenuId((current) => (current === item.id ? null : item.id))}
                  >
                    <MoreHorizontal size={16} />
                  </button>
                  {menuId === item.id && (
                    <div className="flow-menu" role="menu">
                      <Link to={`/sequences/${item.id}`} role="menuitem" onClick={() => setMenuId(null)}>
                        編輯
                      </Link>
                      <button
                        type="button"
                        role="menuitem"
                        disabled={copyingId === item.id}
                        onClick={() => {
                          setMenuId(null);
                          void duplicate(item);
                        }}
                      >
                        {copyingId === item.id ? '複製中…' : '複製'}
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="danger"
                        onClick={() => {
                          setMenuId(null);
                          void remove(item);
                        }}
                      >
                        刪除
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
      {drafting && (
        <DraftAutomationDialog
          ai={ai}
          onClose={() => setDrafting(false)}
          onCreated={(id) => navigate(`/sequences/${id}`)}
        />
      )}
      {creating && (
        <CreateAutomationDialog
          folders={folders}
          campaigns={campaigns}
          onCreated={(id) => navigate(`/sequences/${id}`)}
          onFoldersChange={load}
          onClose={() => setCreating(false)}
        />
      )}
    </div>
  );
}

function DraftAutomationDialog({
  ai,
  onClose,
  onCreated,
}: {
  ai: Session['ai'] | undefined;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [goal, setGoal] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<{
    name: string;
    trigger: Sequence['trigger'];
    triggerValue: string;
    missing: string;
    steps: { delayDays: number; title: string; preheader: string; bodyHtml: string }[];
  } | null>(null);
  const canWrite = Boolean(ai?.writes);
  const blocked = Boolean(draft?.missing) && ['tag', 'folder', 'event'].includes(draft?.trigger ?? '');

  return (
    <Modal title="用 AI 建立" wide onClose={() => { if (!busy) onClose(); }}>
      {error && <div className="notice error">{error}</div>}
      <AiWriteNotice ai={ai} />
      {!draft ? (
        <form onSubmit={(event) => {
          event.preventDefault();
          if (!canWrite) return;
          setBusy(true);
          setError('');
          void api.post<NonNullable<typeof draft>>('/ai/automation', { goal })
            .then(setDraft)
            .catch((err: Error) => setError(err.message))
            .finally(() => setBusy(false));
        }}>
          <label htmlFor="ai-goal">想自動做的事</label>
          <textarea
            id="ai-goal"
            required
            autoFocus={canWrite}
            disabled={!canWrite}
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            placeholder="新訂閱後當天、第 3 天、第 7 天各寄一封歡迎信"
          />
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn primary" type="submit" disabled={busy || !canWrite}>{busy ? '建立中…' : '產生預覽'}</button>
          </div>
        </form>
      ) : (
        <div>
          <p><strong>{draft.name}</strong></p>
          <p className="muted">{TRIGGER_META[draft.trigger]?.label ?? draft.trigger}{draft.triggerValue ? ` · ${draft.triggerValue}` : ''}</p>
          {draft.missing && <div className="notice">{draft.missing}</div>}
          <ol className="ai-steps">
            {draft.steps.map((step) => (
              <li key={`${step.delayDays}-${step.title}`}>第 {step.delayDays} 天 · {step.title}</li>
            ))}
          </ol>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn" onClick={() => setDraft(null)}>重寫</button>
            <button
              type="button"
              className="btn primary"
              disabled={busy || blocked}
              onClick={() => {
                setBusy(true);
                setError('');
                void api.post<{ sequence: Sequence }>('/ai/automation/apply', draft)
                  .then((result) => onCreated(result.sequence.id))
                  .catch((err: Error) => {
                    setError(err.message);
                    setBusy(false);
                  });
              }}
            >
              {busy ? '建立中…' : '建立（先停用）'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function CreateAutomationDialog({
  folders,
  campaigns,
  onCreated,
  onFoldersChange,
  onClose,
}: {
  folders: Folder[];
  campaigns: Campaign[];
  onCreated: (id: string) => void;
  onFoldersChange: () => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<AutomationTemplate>(AUTOMATION_TEMPLATES[0]!);
  const [name, setName] = useState(AUTOMATION_TEMPLATES[0]!.name);
  const [triggerValue, setTriggerValue] = useState('');
  const [folderName, setFolderName] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  const pick = (template: AutomationTemplate) => {
    setSelected(template);
    setName(template.name);
    setTriggerValue('');
    setError('');
  };

  const createFolder = async () => {
    const trimmed = folderName.trim();
    if (!trimmed) return;
    const folder = await api.post<Folder>('/folders', { name: trimmed });
    setFolderName('');
    setTriggerValue(folder.id);
    onFoldersChange();
  };

  const create = async () => {
    setError('');
    const meta = TRIGGER_META[selected.trigger];
    if (meta.needsValue && !triggerValue.trim()) {
      setError(`請先填${meta.valueLabel}`);
      return;
    }
    setSaving(true);
    try {
      const nodes = cloneTemplateNodes(selected, triggerValue.trim());
      const payload = sequencePayloadFromNodes(nodes);
      const created = await api.post<Sequence>('/sequences', {
        name: name.trim() || selected.name,
        trigger: payload.trigger,
        triggerValue: payload.triggerValue,
        steps: payload.steps,
        enabled: false,
      });
      onCreated(created.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : '建立失敗');
      setSaving(false);
    }
  };

  return (
    <div className="modal-root" role="presentation">
      <button type="button" className="modal-backdrop" aria-label="關閉" onClick={onClose} />
      <div className="modal-panel wide" role="dialog" aria-modal="true" aria-labelledby="create-auto-title">
        <header className="modal-header">
          <div>
            <h2 id="create-auto-title">建立自動化</h2>
            <p className="muted">選模板或從空白時間軸開始。建立後還可以拖拉調整。</p>
          </div>
          <ModalClose onClick={onClose} />
        </header>
        <div className="modal-body create-auto">
          {error && <div className="notice error">{error}</div>}
          <div className="create-auto-grid">
            {AUTOMATION_TEMPLATES.map((template) => (
              <button
                key={template.id}
                type="button"
                className={`card template-card ${selected.id === template.id ? 'selected' : ''}`}
                onClick={() => pick(template)}
              >
                <strong>{template.name}</strong>
                <p className="muted">{template.description}</p>
              </button>
            ))}
          </div>
          <aside className="card template-preview">
            <h3>{selected.name}</h3>
            <p className="muted">{selected.description}</p>
            <label>名稱</label>
            <input value={name} onChange={(event) => setName(event.target.value)} />
            {selected.trigger === 'folder' && (
              <div style={{ marginTop: 12 }}>
                <label>資料夾</label>
                <select value={triggerValue} onChange={(event) => setTriggerValue(event.target.value)}>
                  <option value="">選擇資料夾…</option>
                  {folders.map((folder) => (
                    <option key={folder.id} value={folder.id}>
                      {folder.name}
                    </option>
                  ))}
                </select>
                <div className="row" style={{ marginTop: 8 }}>
                  <input
                    placeholder="或新增資料夾"
                    value={folderName}
                    onChange={(event) => setFolderName(event.target.value)}
                  />
                  <button type="button" className="btn" onClick={() => void createFolder()}>
                    新增
                  </button>
                </div>
              </div>
            )}
            {selected.trigger === 'tag' && (
              <div style={{ marginTop: 12 }}>
                <label>標籤名稱</label>
                <input value={triggerValue} onChange={(event) => setTriggerValue(event.target.value)} placeholder="例如 welcome" />
              </div>
            )}
            {selected.trigger === 'event' && (
              <div style={{ marginTop: 12 }}>
                <label>{TRIGGER_META.event.valueLabel}</label>
                <input value={triggerValue} onChange={(event) => setTriggerValue(event.target.value)} placeholder="例如 course_purchased" />
              </div>
            )}
            {(selected.trigger === 'open' || selected.trigger === 'click') && (
              <div style={{ marginTop: 12 }}>
                <label htmlFor="create-auto-campaign">哪一封電子報</label>
                <CampaignSelect
                  id="create-auto-campaign"
                  campaigns={campaigns}
                  value={triggerValue}
                  emptyLabel="任何一封"
                  onChange={setTriggerValue}
                />
              </div>
            )}
            <TimelinePreview nodes={selected.nodes} />
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
              <button type="button" className="btn ghost" onClick={onClose}>
                返回
              </button>
              <button type="button" className="btn primary" disabled={saving} onClick={() => void create()}>
                {saving ? '建立中…' : '建立自動化'}
              </button>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

function TimelinePreview({ nodes }: { nodes: FlowNode[] }) {
  return (
    <ol className="flow-preview">
      {nodes.map((item) => (
        <li key={item.id} className={`flow-preview-node ${item.kind}`}>
          {item.kind === 'exit' ? 'END OF AUTOMATION' : nodeLabel(item)}
        </li>
      ))}
    </ol>
  );
}

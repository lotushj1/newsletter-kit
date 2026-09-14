import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  AUTOMATION_TEMPLATES,
  TRIGGER_META,
  cloneTemplateNodes,
  nodeLabel,
  sequencePayloadFromNodes,
  type AutomationTemplate,
  type FlowNode,
} from '../automation';
import { api, formatTime, type Campaign, type Folder, type Sequence } from '../api';
import { ModalClose } from '../components/ModalClose';
import { Switch } from '../components/Switch';

type Filter = 'all' | 'active' | 'inactive';

export function Sequences() {
  const navigate = useNavigate();
  const [items, setItems] = useState<Sequence[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);

  const load = () => {
    void api
      .get<{ items: Sequence[] }>('/sequences')
      .then((data) => setItems(data.items))
      .catch((err: Error) => setError(err.message));
    void api.get<{ items: Folder[] }>('/folders').then((data) => setFolders(data.items));
    void api.get<{ items: Campaign[] }>('/campaigns?limit=100').then((data) => setCampaigns(data.items));
  };

  useEffect(load, []);

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

  return (
    <div>
      {error && <div className="notice error">{error}</div>}
      <div className="page-head">
        <h1>自動化</h1>
        <button type="button" className="btn primary" onClick={() => setCreating(true)}>
          建立自動化
        </button>
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
        <p className="muted">{items.length === 0 ? '還沒有自動化。從模板或空白時間軸開始。' : '沒有符合條件的自動化。'}</p>
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
                <Link className="btn" to={`/sequences/${item.id}`}>
                  編輯
                </Link>
                <button type="button" className="btn danger" onClick={() => void remove(item)}>
                  刪除
                </button>
              </div>
            </article>
          ))}
        </div>
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
                <label>哪一封電子報</label>
                <select value={triggerValue} onChange={(event) => setTriggerValue(event.target.value)}>
                  <option value="">任何一封</option>
                  {campaigns.map((campaign) => (
                    <option key={campaign.id} value={campaign.id}>
                      {campaign.title}
                    </option>
                  ))}
                </select>
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

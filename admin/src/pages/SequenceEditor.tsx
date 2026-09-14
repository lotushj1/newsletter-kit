import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Clock,
  FolderPlus,
  Mail,
  MailOpen,
  MoreHorizontal,
  MousePointerClick,
  Plus,
  Tag,
  Trash2,
  UserMinus,
  UserPlus,
  Webhook,
} from 'lucide-react';
import {
  TRIGGER_META,
  cloneFlowNode,
  hasSendableStep,
  newNodeId,
  nodeLabel,
  nodesFromSequence,
  sequencePayloadFromNodes,
  type FlowKind,
  type FlowNode,
  type TriggerKind,
} from '../automation';
import { api, type Campaign, type Folder, type Sequence } from '../api';
import { CampaignSelect } from '../components/CampaignSelect';
import { Switch } from '../components/Switch';
import { Toast } from '../components/Toast';

const ADD_MENU: { kind: 'wait' | 'send'; label: string; icon: typeof Clock }[] = [
  { kind: 'wait', label: '等待幾天', icon: Clock },
  { kind: 'send', label: '寄出電子報', icon: Mail },
];

const TRIGGER_ICON: Record<TriggerKind, typeof UserPlus> = {
  subscribe: UserPlus,
  unsubscribe: UserMinus,
  folder: FolderPlus,
  tag: Tag,
  open: MailOpen,
  click: MousePointerClick,
  event: Webhook,
};

const NODE_ICON: Record<Exclude<FlowKind, 'exit'>, typeof Clock> = {
  trigger: UserPlus,
  wait: Clock,
  send: Mail,
};

type DragPayload =
  | { source: 'palette'; kind: FlowKind; trigger?: TriggerKind }
  | { source: 'canvas'; id: string };

export function SequenceEditor() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [sequence, setSequence] = useState<Sequence | null>(null);
  const [name, setName] = useState('');
  const [nodes, setNodes] = useState<FlowNode[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [selectedId, setSelectedId] = useState('trigger');
  const [menuId, setMenuId] = useState<string | null>(null);
  const [addIndex, setAddIndex] = useState<number | null>(null);
  const [saveStatus, setSaveStatus] = useState('尚未儲存');
  const [toast, setToast] = useState<{ title: string; body?: string } | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const loaded = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const toastTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    loaded.current = false;
    void api.get<Sequence>(`/sequences/${id}`).then((item) => {
      setSequence(item);
      setName(item.name);
      setNodes(nodesFromSequence(item));
      setSelectedId('trigger');
      loaded.current = true;
      setSaveStatus('已載入');
    });
    void api.get<{ items: Campaign[] }>('/campaigns?limit=100').then((data) => setCampaigns(data.items));
    void api.get<{ items: Folder[] }>('/folders').then((data) => setFolders(data.items));
  }, [id]);

  useEffect(() => {
    if (!menuId && addIndex === null) return;
    const close = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('[data-node-menu], [data-node-add], .flow-menu')) return;
      setMenuId(null);
      setAddIndex(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuId(null);
        setAddIndex(null);
      }
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuId, addIndex]);

  const selected = nodes.find((item) => item.id === selectedId) ?? nodes[0];

  const persist = useCallback(
    async (nextName = name, nextNodes = nodes, enabled?: boolean) => {
      const payload = sequencePayloadFromNodes(nextNodes);
      const updated = await api.patch<Sequence>(`/sequences/${id}`, {
        name: nextName.trim() || '未命名自動化',
        trigger: payload.trigger,
        triggerValue: payload.triggerValue ?? '',
        steps: payload.steps,
        ...(enabled === undefined ? {} : { enabled }),
      });
      setSequence(updated);
      setSaveStatus('已自動儲存');
      return updated;
    },
    [id, name, nodes],
  );

  useEffect(() => {
    if (!loaded.current) return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      void persist().catch((err: Error) => setSaveStatus(err.message));
    }, 800);
    return () => window.clearTimeout(timer.current);
  }, [name, nodes, persist]);

  const insertNode = (kind: FlowKind, trigger: TriggerKind | undefined, at: number) => {
    if (kind === 'exit') {
      setMenuId(null);
      setAddIndex(null);
      return;
    }
    if (kind === 'trigger') {
      const created: FlowNode = {
        id: 'trigger',
        kind: 'trigger',
        trigger: trigger ?? 'subscribe',
        triggerValue: '',
      };
      setNodes((current) => {
        const existing = current.findIndex((item) => item.kind === 'trigger');
        if (existing >= 0) {
          return current.map((item, index) => (index === existing ? { ...item, ...created, id: item.id } : item));
        }
        return [created, ...current];
      });
      setSelectedId('trigger');
      setMenuId(null);
      setAddIndex(null);
      return;
    }
    const created: FlowNode =
      kind === 'wait'
        ? { id: newNodeId(), kind: 'wait', days: 1 }
        : { id: newNodeId(), kind: 'send', campaignId: '' };
    setNodes((current) => {
      const next = [...current];
      const exitAt = next.findIndex((item) => item.kind === 'exit');
      const max = exitAt >= 0 ? exitAt : next.length;
      const index = Math.min(Math.max(at, 0), max);
      next.splice(index, 0, created);
      return next;
    });
    setSelectedId(created.id);
    setMenuId(null);
    setAddIndex(null);
  };

  const moveNode = (nodeId: string, at: number) => {
    setNodes((current) => {
      const from = current.findIndex((item) => item.id === nodeId);
      const moving = current[from];
      if (!moving || moving.kind === 'exit') return current;
      const without = current.filter((item) => item.id !== nodeId);
      const exitAt = without.findIndex((item) => item.kind === 'exit');
      const max = exitAt >= 0 ? exitAt : without.length;
      const adjusted = at > from ? at - 1 : at;
      const index = Math.min(Math.max(adjusted, 0), max);
      without.splice(index, 0, moving);
      return without;
    });
  };

  const onDropAt = (index: number, event: React.DragEvent) => {
    event.preventDefault();
    setDropIndex(null);
    const raw = event.dataTransfer.getData('application/json');
    if (!raw) return;
    const payload = JSON.parse(raw) as DragPayload;
    if (payload.source === 'palette') insertNode(payload.kind, payload.trigger, index);
    else moveNode(payload.id, index);
  };

  const updateSelected = (patch: Partial<FlowNode>) => {
    setNodes((current) => current.map((item) => (item.id === selectedId ? { ...item, ...patch } : item)));
  };

  const removeNode = (nodeId: string) => {
    setNodes((current) => {
      const target = current.find((item) => item.id === nodeId);
      if (!target || target.kind === 'exit') return current;
      const next = current.filter((item) => item.id !== nodeId);
      setSelectedId(next.find((item) => item.kind !== 'exit')?.id ?? next[0]?.id ?? '');
      return next;
    });
    setMenuId(null);
    setAddIndex(null);
  };

  const duplicateNode = (nodeId: string) => {
    setNodes((current) => {
      const index = current.findIndex((item) => item.id === nodeId);
      const target = current[index];
      if (!target || target.kind === 'exit') return current;
      const copy = cloneFlowNode(target);
      const next = [...current];
      const exitAt = next.findIndex((item) => item.kind === 'exit');
      next.splice(Math.min(index + 1, exitAt >= 0 ? exitAt : next.length), 0, copy);
      setSelectedId(copy.id);
      return next;
    });
    setMenuId(null);
    setAddIndex(null);
  };

  const showToast = (next: { title: string; body?: string }) => {
    window.clearTimeout(toastTimer.current);
    setToast(next);
    toastTimer.current = window.setTimeout(() => setToast(null), 6500);
  };

  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  const toggleEnabled = async () => {
    setToast(null);
    if (!sequence?.enabled && !hasSendableStep(nodes)) {
      const unfinished = nodes.find((item) => item.kind === 'send' && !item.campaignId);
      if (unfinished) setSelectedId(unfinished.id);
      showToast({ title: '請先設定', body: '先選好要寄的信，才能啟用。' });
      return;
    }
    try {
      await persist(name, nodes, !sequence?.enabled);
    } catch (err) {
      showToast({
        title: '還沒存好',
        body: err instanceof Error ? err.message : '更新失敗',
      });
    }
  };

  const createCampaignForNode = async () => {
    const created = await api.post<Campaign>('/campaigns', {
      title: `${name || '自動化'} · 信件`,
      bodyHtml: '<p>嗨 {{name}}，</p><p>這裡是這封自動化信件。</p>',
    });
    setCampaigns((current) => [created, ...current]);
    updateSelected({ campaignId: created.id });
  };

  const triggerHint = useMemo(() => {
    const trigger = nodes.find((item) => item.kind === 'trigger');
    return TRIGGER_META[trigger?.trigger ?? 'subscribe'];
  }, [nodes]);

  if (!sequence) return <p className="muted" style={{ padding: 24 }}>載入中…</p>;

  return (
    <div className="flow-shell">
      <div className="flow-main">
        <div className="flow-toolbar">
          <input
            className="editor-title"
            style={{ fontSize: 22, margin: 0 }}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <span className="muted">{saveStatus}</span>
          <Switch checked={sequence.enabled} onChange={() => void toggleEnabled()} />
          <button type="button" className="btn ghost flow-toolbar-back" onClick={() => navigate('/sequences')}>
            返回列表
          </button>
        </div>
        {toast && (
          <Toast title={toast.title} body={toast.body} onClose={() => setToast(null)} />
        )}
        <div className="flow-canvas" onClick={() => setSelectedId(nodes.find((item) => item.kind === 'trigger')?.id ?? '')}>
          <div className="flow-track">
            {nodes.map((item, index) => {
              const Icon = item.kind === 'trigger'
                ? (TRIGGER_ICON[item.trigger ?? 'subscribe'] ?? UserPlus)
                : item.kind === 'exit'
                  ? null
                  : NODE_ICON[item.kind];
              const foot = item.kind === 'exit' ? null : nodeFoot(item, sequence, campaigns);
              const missingValue = item.kind === 'trigger' && triggerHint.needsValue && !item.triggerValue;
              return (
                <div key={item.id} className={`flow-step ${item.kind}`}>
                  {index > 0 && (
                    <FlowLine
                      active={dropIndex === index}
                      open={addIndex === index}
                      onToggle={() => {
                        setMenuId(null);
                        setAddIndex((current) => (current === index ? null : index));
                      }}
                      onInsert={(kind) => insertNode(kind, undefined, index)}
                      onDragOver={(event) => {
                        event.preventDefault();
                        setDropIndex(index);
                      }}
                      onDragLeave={() => setDropIndex(null)}
                      onDrop={(event) => onDropAt(index, event)}
                    />
                  )}
                  {item.kind === 'exit' ? (
                    <div className="flow-end">END OF AUTOMATION</div>
                  ) : (
                    <div className="flow-card-row">
                      <div
                        role="button"
                        tabIndex={0}
                        className={`flow-card ${item.kind} ${selectedId === item.id ? 'selected' : ''}`}
                        draggable
                        onClick={(event) => {
                          event.stopPropagation();
                          setSelectedId(item.id);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            setSelectedId(item.id);
                          }
                        }}
                        onDragStart={(event) => {
                          if ((event.target as HTMLElement).closest('[data-node-menu]')) {
                            event.preventDefault();
                            return;
                          }
                          event.dataTransfer.setData('application/json', JSON.stringify({ source: 'canvas', id: item.id }));
                          event.dataTransfer.effectAllowed = 'move';
                        }}
                      >
                        <span className="flow-card-badge" aria-hidden="true">
                          {Icon && <Icon size={18} strokeWidth={2} />}
                        </span>
                        <div className="flow-card-main">
                          <strong>{nodeTitle(item, campaigns)}</strong>
                          {item.kind === 'send' && !item.campaignId && <span className="flow-warn">還沒選電子報</span>}
                          {missingValue && <span className="flow-warn">還沒設定{triggerHint.valueLabel}</span>}
                          <NodeMenu
                            open={menuId === item.id}
                            onToggle={() => {
                              setAddIndex(null);
                              setMenuId((current) => (current === item.id ? null : item.id));
                            }}
                            onDuplicate={() => duplicateNode(item.id)}
                            onRemove={() => removeNode(item.id)}
                          />
                        </div>
                        {foot && (
                          <div className="flow-card-foot">
                            <span>{foot}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <aside className="flow-inspect" onClick={(event) => event.stopPropagation()}>
        {!selected ? (
          <p className="muted">點時間軸上的節點來設定。</p>
        ) : selected.kind === 'trigger' ? (
          <>
            <h3>觸發條件</h3>
            <label>什麼時候開始</label>
            <select
              value={selected.trigger ?? 'subscribe'}
              onChange={(event) => {
                const next = event.target.value as TriggerKind;
                const keep =
                  (next === 'open' || next === 'click') &&
                  (selected.trigger === 'open' || selected.trigger === 'click');
                updateSelected({
                  trigger: next,
                  triggerValue: keep ? selected.triggerValue : '',
                });
              }}
            >
              {(Object.keys(TRIGGER_META) as TriggerKind[]).map((value) => (
                <option key={value} value={value}>
                  {TRIGGER_META[value].label}
                </option>
              ))}
            </select>
            <p className="muted" style={{ marginTop: 8 }}>
              {TRIGGER_META[selected.trigger ?? 'subscribe'].hint}
            </p>
            {(selected.trigger ?? 'subscribe') === 'folder' && (
              <div style={{ marginTop: 12 }}>
                <label>資料夾</label>
                <select
                  value={selected.triggerValue ?? ''}
                  onChange={(event) => updateSelected({ triggerValue: event.target.value })}
                >
                  <option value="">選擇…</option>
                  {folders.map((folder) => (
                    <option key={folder.id} value={folder.id}>
                      {folder.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {(selected.trigger ?? 'subscribe') === 'tag' && (
              <div style={{ marginTop: 12 }}>
                <label>標籤名稱</label>
                <input
                  value={selected.triggerValue ?? ''}
                  onChange={(event) => updateSelected({ triggerValue: event.target.value })}
                />
              </div>
            )}
            {(selected.trigger ?? 'subscribe') === 'event' && (
              <div style={{ marginTop: 12 }}>
                <label>{TRIGGER_META.event.valueLabel}</label>
                <input
                  value={selected.triggerValue ?? ''}
                  onChange={(event) => updateSelected({ triggerValue: event.target.value })}
                />
              </div>
            )}
            {((selected.trigger ?? 'subscribe') === 'open' || (selected.trigger ?? 'subscribe') === 'click') && (
              <div style={{ marginTop: 12 }}>
                <label htmlFor="sequence-trigger-campaign">哪一封電子報</label>
                <CampaignSelect
                  id="sequence-trigger-campaign"
                  campaigns={campaigns}
                  value={selected.triggerValue ?? ''}
                  emptyLabel="任何一封"
                  onChange={(campaignId) => updateSelected({ triggerValue: campaignId })}
                />
              </div>
            )}
          </>
        ) : selected.kind === 'wait' ? (
          <>
            <h3>等待</h3>
            <label>幾天後繼續</label>
            <input
              type="number"
              min={0}
              max={365}
              value={selected.days ?? 1}
              onChange={(event) => updateSelected({ days: Number(event.target.value) })}
            />
            <button type="button" className="btn danger" style={{ marginTop: 16 }} onClick={() => removeNode(selected.id)}>
              <Trash2 size={14} /> 刪除這個等待
            </button>
          </>
        ) : selected.kind === 'send' ? (
          <>
            <h3>寄出電子報</h3>
            <label htmlFor="sequence-send-campaign">用哪封信</label>
            <CampaignSelect
              id="sequence-send-campaign"
              campaigns={campaigns}
              value={selected.campaignId ?? ''}
              emptyLabel="選擇電子報…"
              onChange={(campaignId) => updateSelected({ campaignId })}
            />
            <div className="row" style={{ marginTop: 12 }}>
              <button type="button" className="btn" onClick={() => void createCampaignForNode()}>
                新建一封
              </button>
              {selected.campaignId && (
                <Link className="btn" to={`/campaigns/${selected.campaignId}`}>
                  編輯這封信
                </Link>
              )}
            </div>
            <button type="button" className="btn danger" style={{ marginTop: 16 }} onClick={() => removeNode(selected.id)}>
              <Trash2 size={14} /> 刪除這個步驟
            </button>
          </>
        ) : (
          <p className="muted">走到這裡完成自動化</p>
        )}
      </aside>
    </div>
  );
}

function nodeTitle(node: FlowNode, campaigns: Campaign[]): string {
  if (node.kind === 'send') {
    const campaign = campaigns.find((item) => item.id === node.campaignId);
    return campaign?.title ?? (node.campaignId ? '電子報' : '寄出電子報');
  }
  return nodeLabel(node);
}

function nodeFoot(
  node: FlowNode,
  sequence: Sequence,
  campaigns: Campaign[],
): string {
  if (node.kind === 'trigger') {
    return `${sequence.enabled ? '啟用中' : '未啟用'} · ${sequence.stats?.active ?? 0} 進行中`;
  }
  if (node.kind === 'wait') {
    return `等待 ${node.days ?? 1} 天`;
  }
  if (node.kind === 'send') {
    const campaign = campaigns.find((item) => item.id === node.campaignId);
    return campaign?.title ?? '未設定';
  }
  return `${sequence.stats?.completed ?? 0} 已完成`;
}

function NodeMenu({
  open,
  onToggle,
  onDuplicate,
  onRemove,
}: {
  open: boolean;
  onToggle: () => void;
  onDuplicate: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="flow-node-menu" data-node-menu>
      <button
        type="button"
        className="icon"
        aria-label="更多"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={(event) => {
          event.stopPropagation();
          onToggle();
        }}
      >
        <MoreHorizontal size={16} />
      </button>
      {open && (
        <div className="flow-menu" role="menu">
          <button type="button" role="menuitem" onClick={onDuplicate}>
            複製
          </button>
          <button type="button" role="menuitem" className="danger" onClick={onRemove}>
            移除
          </button>
        </div>
      )}
    </div>
  );
}

function FlowLine({
  active,
  open,
  onToggle,
  onInsert,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  active: boolean;
  open: boolean;
  onToggle: () => void;
  onInsert: (kind: 'wait' | 'send') => void;
  onDragOver: (event: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (event: React.DragEvent) => void;
}) {
  return (
    <div
      className={`flow-line ${active ? 'active' : ''}`}
      data-node-add
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <button
        type="button"
        className="flow-line-add"
        aria-label="新增步驟"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={(event) => {
          event.stopPropagation();
          onToggle();
        }}
      >
        <Plus size={16} strokeWidth={2.75} />
      </button>
      {open && (
        <div
          className="flow-menu flow-menu-add"
          role="menu"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          {ADD_MENU.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.kind}
                type="button"
                role="menuitem"
                onPointerDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onInsert(item.kind);
                }}
              >
                <Icon size={14} />
                {item.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

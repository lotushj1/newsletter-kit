import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useOutletContext, useParams } from 'react-router-dom';
import { PreviewDialog } from '../components/PreviewDialog';
import { TiptapEditor } from '../components/TiptapEditor';
import { AiWriteNotice } from '../components/AiWriteNotice';
import { Modal } from '../components/Modal';
import { api, formatTime, STATUS_LABEL, type Campaign, type Folder, type Session } from '../api';
import type { AudienceCondition } from '../../../src/store/types';

const LOCKED = ['sending', 'sent'];

const DEFAULT_CONDITION: AudienceCondition = { op: 'status', status: 'subscribed' };

function AudienceBuilder({ value, onChange, disabled, folders }: {
  value: AudienceCondition | undefined;
  onChange: (value: AudienceCondition | undefined) => void;
  disabled: boolean;
  folders: Folder[];
}) {
  return <div style={{ marginTop: 12 }}>
    <strong>進階受眾條件</strong>
    {value ? <><AudienceNode value={value} onChange={onChange} disabled={disabled} folders={folders} /><button type="button" className="btn ghost" disabled={disabled} onClick={() => onChange(undefined)}>清除進階條件</button></> :
      <button type="button" className="btn" disabled={disabled} onClick={() => onChange({ op: 'and', children: [DEFAULT_CONDITION] })}>新增條件</button>}
  </div>;
}

function AudienceNode({ value, onChange, disabled, folders }: {
  value: AudienceCondition;
  onChange: (value: AudienceCondition) => void;
  disabled: boolean;
  folders: Folder[];
}) {
  const changeOp = (op: string) => {
    if (op === 'and' || op === 'or') onChange({ op, children: [DEFAULT_CONDITION] });
    else if (op === 'not') onChange({ op, child: DEFAULT_CONDITION });
    else if (op === 'tag') onChange({ op, tag: '' });
    else if (op === 'folder') onChange({ op, folderId: '' });
    else if (op === 'status') onChange({ op, status: 'subscribed' });
    else if (op === 'created') onChange({ op, after: '' });
    else onChange({ op: 'engagement', event: 'open', withinDays: 90 });
  };
  return <div style={{ margin: '8px 0 8px 10px', paddingLeft: 10, borderLeft: '2px solid #ddd' }}>
    <select aria-label="條件類型" value={value.op} disabled={disabled} onChange={(event) => changeOp(event.target.value)}>
      <option value="and">全部符合（AND）</option><option value="or">任一符合（OR）</option><option value="not">排除（NOT）</option>
      <option value="tag">擁有標籤</option><option value="folder">位於資料夾</option><option value="status">訂閱狀態</option>
      <option value="created">加入日期</option><option value="engagement">開信／點擊</option>
    </select>
    {(value.op === 'and' || value.op === 'or') && <>
      {value.children.map((child, index) => <div key={index} className="row"><AudienceNode value={child} disabled={disabled} folders={folders} onChange={(next) => onChange({ ...value, children: value.children.map((item, i) => i === index ? next : item) })} /><button type="button" className="btn ghost" disabled={disabled} onClick={() => onChange({ ...value, children: value.children.filter((_, i) => i !== index) })}>移除</button></div>)}
      <button type="button" className="btn ghost" disabled={disabled} onClick={() => onChange({ ...value, children: [...value.children, DEFAULT_CONDITION] })}>加入條件</button>
    </>}
    {value.op === 'not' && <AudienceNode value={value.child} disabled={disabled} folders={folders} onChange={(child) => onChange({ op: 'not', child })} />}
    {value.op === 'tag' && <input aria-label="標籤" value={value.tag} disabled={disabled} onChange={(event) => onChange({ op: 'tag', tag: event.target.value })} placeholder="標籤名稱" />}
    {value.op === 'folder' && <select aria-label="訂閱者資料夾" value={value.folderId} disabled={disabled} onChange={(event) => onChange({ op: 'folder', folderId: event.target.value })}><option value="">選擇資料夾</option><option value="unfiled">未分類</option>{folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select>}
    {value.op === 'status' && <select aria-label="訂閱狀態" value={value.status} disabled={disabled} onChange={(event) => onChange({ op: 'status', status: event.target.value as typeof value.status })}><option value="subscribed">已訂閱</option><option value="pending">待確認</option><option value="unsubscribed">已退訂</option><option value="bounced">退信</option></select>}
    {value.op === 'created' && <><label>起始日<input type="date" value={value.after?.slice(0, 10) ?? ''} disabled={disabled} onChange={(event) => onChange({ ...value, after: event.target.value })} /></label><label>截止日<input type="date" value={value.before?.slice(0, 10) ?? ''} disabled={disabled} onChange={(event) => onChange({ ...value, before: event.target.value })} /></label></>}
    {value.op === 'engagement' && <><select aria-label="互動類型" value={value.event} disabled={disabled} onChange={(event) => onChange({ ...value, event: event.target.value as 'open' | 'click' })}><option value="open">開信</option><option value="click">點擊</option></select><input aria-label="電子報 ID" value={value.campaignId ?? ''} disabled={disabled} onChange={(event) => onChange({ ...value, campaignId: event.target.value || undefined })} placeholder="指定電子報 ID（可留空）" /><input type="number" min="1" max="3650" aria-label="最近幾天" value={value.withinDays ?? ''} disabled={disabled} onChange={(event) => onChange({ ...value, withinDays: Number(event.target.value) || undefined })} placeholder="最近天數" />{value.event === 'click' && <input type="url" aria-label="指定連結" value={value.url ?? ''} disabled={disabled} onChange={(event) => onChange({ ...value, url: event.target.value || undefined })} placeholder="指定 URL（可留空）" />}</>}
  </div>;
}

export function CampaignEditor() {
  const { id = '' } = useParams();
  const session = useOutletContext<Session | null>();
  const aiWrites = Boolean(session?.ai.writes);
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [title, setTitle] = useState('');
  const [preheader, setPreheader] = useState('');
  const [bodyHtml, setBodyHtml] = useState('');
  const [folderId, setFolderId] = useState('');
  const [audienceTags, setAudienceTags] = useState<string[]>([]);
  const [audienceCondition, setAudienceCondition] = useState<AudienceCondition | undefined>();
  const [audienceCount, setAudienceCount] = useState<number | null>(null);
  const [links, setLinks] = useState<{ url: string; clicks: number; uniqueClicks: number }[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [saveStatus, setSaveStatus] = useState('尚未儲存');
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewHtml, setPreviewHtml] = useState('');
  const [previewing, setPreviewing] = useState(false);
  const [testEmail, setTestEmail] = useState('');
  const [scheduleAt, setScheduleAt] = useState('');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const hideStatus = useRef<number | undefined>(undefined);
  const loaded = useRef(false);
  const inspectHostRef = useRef<HTMLDivElement>(null);
  const [inspectingButton, setInspectingButton] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiMode, setAiMode] = useState<null | 'draft' | 'subjects'>(null);
  const [aiError, setAiError] = useState('');
  const [brief, setBrief] = useState('');
  const [draftPreview, setDraftPreview] = useState<{ title: string; preheader: string; bodyHtml: string } | null>(null);
  const [subjectOptions, setSubjectOptions] = useState<{ subject: string; preheader: string }[] | null>(null);

  const editable = campaign ? !LOCKED.includes(campaign.status) : false;

  useEffect(() => {
    void api.get<Campaign>(`/campaigns/${id}`).then((c) => {
      setCampaign(c);
      setTitle(c.title);
      setPreheader(c.preheader ?? '');
      setBodyHtml(c.bodyHtml || c.bodyMarkdown || '');
      setFolderId(c.audienceFolderId ?? '');
      setAudienceTags(c.audienceTags ?? []);
      setAudienceCondition(c.audienceCondition);
      if (c.scheduledAt) setScheduleAt(c.scheduledAt.slice(0, 16));
      loaded.current = true;
    });
    void api.get<{ items: Folder[] }>('/folders').then((data) => setFolders(data.items));
    void api.get<{ items: { url: string; clicks: number; uniqueClicks: number }[] }>(`/campaigns/${id}/links`).then((data) => setLinks(data.items));
  }, [id]);

  const save = useCallback(async () => {
    if (!editable) return;
    window.clearTimeout(hideStatus.current);
    setSaveStatus('儲存中…');
    const updated = await api.patch<Campaign>(`/campaigns/${id}`, {
      title,
      subject: title,
      preheader,
      bodyHtml,
      audienceTags,
      audienceFolderId: folderId,
      audienceCondition: audienceCondition ?? null,
    });
    setCampaign(updated);
    setSaveStatus('已自動儲存');
    hideStatus.current = window.setTimeout(() => {
      setSaveStatus((current) => (current === '已自動儲存' ? '' : current));
    }, 2000);
  }, [editable, id, title, preheader, bodyHtml, folderId, audienceTags, audienceCondition]);

  useEffect(() => {
    if (!loaded.current || !editable) return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      void save().catch((err: Error) => setSaveStatus(err.message));
    }, 1200);
    return () => window.clearTimeout(timer.current);
  }, [title, preheader, bodyHtml, folderId, audienceTags, audienceCondition, editable, save]);

  useEffect(() => () => window.clearTimeout(hideStatus.current), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 's') {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  if (!campaign) return <p className="muted" style={{ padding: 24 }}>載入中…</p>;

  const runAi = async (work: () => Promise<void>) => {
    setAiError('');
    setAiBusy(true);
    try {
      await work();
    } catch (err) {
      setAiError(err instanceof Error ? err.message : 'AI 失敗');
    } finally {
      setAiBusy(false);
    }
  };

  const closeAi = () => {
    if (aiBusy) return;
    setAiMode(null);
    setAiError('');
  };

  return (
    <div className="editor-shell">
      <div className="editor-main">
        <p className="muted" style={{ margin: '0 0 12px' }}>
          <Link to="/campaigns">← 電子報列表</Link>
          <span style={{ marginLeft: 12 }}>{saveStatus}</span>
        </p>
        <input className="editor-title" value={title} disabled={!editable} onChange={(e) => setTitle(e.target.value)} placeholder="標題" />
        <div className="editor-meta">
          <div>
            <div className="editor-field-head">
              <label htmlFor="editor-preheader">前導文字</label>
              {editable && (
                <button
                  type="button"
                  className="editor-ai-text"
                  onClick={() => { setAiError(''); setSubjectOptions(null); setAiMode('subjects'); }}
                >
                  建議標題
                </button>
              )}
            </div>
            <input id="editor-preheader" value={preheader} disabled={!editable} onChange={(e) => setPreheader(e.target.value)} placeholder="收件匣預覽那一行，可留空" />
          </div>
        </div>
        <TiptapEditor
          value={bodyHtml}
          onChange={setBodyHtml}
          editable={editable}
          inspectHost={inspectHostRef}
          onInspectingChange={setInspectingButton}
          onAiDraft={editable ? () => { setAiError(''); setDraftPreview(null); setAiMode('draft'); } : undefined}
          aiRewrite={editable && aiWrites}
        />
      </div>
      <aside className="editor-side">
        <div ref={inspectHostRef} className="editor-side-inspect" hidden={!inspectingButton} />
        {inspectingButton ? null : (
        <>
        <div>
          <span className={`pill ${campaign.status}`}>{STATUS_LABEL[campaign.status]}</span>
          <p className="muted" style={{ margin: '8px 0 0' }}>更新於 {formatTime(campaign.updatedAt)}</p>
        </div>
        {campaign.status === 'failed' && (
          <div className="notice error">
            上次寄送失敗或中斷。可以直接「立刻寄送」重寄：已成功寄出的收件人不會再收到一次，
            只會補寄失敗與未寄出的部分。
          </div>
        )}
        {campaign.status === 'sending' && (
          <div className="notice">
            寄送中。若超過 5 分鐘沒有進度，重新整理後會顯示為「失敗」，即可重新寄送。
          </div>
        )}
        <div>
          <label>寄給誰</label>
          <select value={folderId} disabled={!editable} onChange={(e) => setFolderId(e.target.value)}>
            <option value="">全部訂閱者</option>
            {folders.map((folder) => (
              <option key={folder.id} value={folder.id}>{folder.name}</option>
            ))}
          </select>
          <label htmlFor="audience-tags">舊版標籤篩選（任一標籤）</label>
          <input id="audience-tags" value={audienceTags.join(', ')} disabled={!editable} onChange={(event) => setAudienceTags(event.target.value.split(',').map((tag) => tag.trim().toLowerCase()).filter(Boolean))} placeholder="標籤，以逗號分隔" />
          <AudienceBuilder value={audienceCondition} onChange={setAudienceCondition} disabled={!editable} folders={folders} />
          <button type="button" className="btn" onClick={() => { void api.post<{ count: number }>(`/campaigns/${id}/audience-count`, { audienceTags, audienceFolderId: folderId, audienceCondition: audienceCondition ?? null }).then((result) => setAudienceCount(result.count)).catch((error: Error) => setMessage(error.message)); }}>預覽收件人數</button>
          {audienceCount !== null && <p className="muted">符合條件：{audienceCount} 位</p>}
        </div>
        {campaign.status === 'sent' && (
          <div className="card">
            <div>開信 {campaign.tracking.uniqueOpens}／{campaign.tracking.opens}</div>
            <div>點擊 {campaign.tracking.uniqueClicks}／{campaign.tracking.clicks}</div>
            <div>退訂 {campaign.tracking.unsubscribes ?? 0}</div>
            <div className="muted">寄出 {campaign.stats.sent}／{campaign.stats.total}</div>
            <h3>連結點擊</h3>
            <table><thead><tr><th>連結</th><th>點擊</th><th>不重複</th></tr></thead><tbody>{links.map((link) => <tr key={link.url}><td style={{ overflowWrap: 'anywhere' }}><a href={link.url} target="_blank" rel="noreferrer">{link.url}</a></td><td>{link.clicks}</td><td>{link.uniqueClicks}</td></tr>)}</tbody></table>
          </div>
        )}
        <button
          type="button"
          className="btn"
          disabled={previewing}
          onClick={() => {
            setPreviewOpen(true);
            setPreviewHtml('');
            setPreviewing(true);
            void api
              .post<{ html: string; subject: string }>(`/campaigns/${id}/preview`, {
                subject: title,
                preheader,
                bodyHtml,
                audienceTags,
                audienceFolderId: folderId,
                audienceCondition: audienceCondition ?? null,
              })
              .then((r) => {
                setPreviewHtml(r.html);
              })
              .catch((err: Error) => setMessage(err.message))
              .finally(() => setPreviewing(false));
          }}
        >
          {previewing ? '預覽中…' : '預覽'}
        </button>
        <div>
          <label>測試信</label>
          <div className="row">
            <input className="grow" type="email" value={testEmail} onChange={(e) => setTestEmail(e.target.value)} placeholder="you@example.com" />
            <button
              type="button"
              className="btn"
              onClick={() => {
                void save().then(() =>
                  api.post(`/campaigns/${id}/test`, { email: testEmail }).then((r: { message?: string }) => setMessage(r.message ?? '已寄出')),
                ).catch((err: Error) => setMessage(err.message));
              }}
            >
              寄出
            </button>
          </div>
        </div>
        {editable && (
          <>
            <div>
              <label>排程</label>
              <input type="datetime-local" value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)} />
              <button
                type="button"
                className="btn"
                style={{ marginTop: 8, width: '100%' }}
                onClick={() => {
                  void save()
                    .then(() => api.post(`/campaigns/${id}/schedule`, { scheduledAt: new Date(scheduleAt).toISOString() }))
                    .then((c) => { setCampaign(c as Campaign); setMessage('已排程'); })
                    .catch((err: Error) => setMessage(err.message));
                }}
              >
                排程寄送
              </button>
            </div>
            {campaign.status === 'scheduled' && (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  void api.post<Campaign>(`/campaigns/${id}/unschedule`).then((c) => setCampaign(c));
                }}
              >
                取消排程
              </button>
            )}
            <button
              type="button"
              className="btn primary"
              disabled={sending}
              onClick={() => {
                if (!window.confirm('確定立刻寄給符合條件的訂閱者？')) return;
                setSending(true);
                void save()
                  .then(() => api.post(`/campaigns/${id}/send`))
                  .then(() => { setMessage('開始寄送'); setCampaign({ ...campaign, status: 'sending' }); })
                  .catch((err: Error) => setMessage(err.message))
                  .finally(() => setSending(false));
              }}
            >
              立刻寄送
            </button>
          </>
        )}
        {message && <div className="notice">{message}</div>}
        </>
        )}
      </aside>
      <PreviewDialog
        open={previewOpen}
        html={previewHtml}
        title={title}
        loading={previewing}
        onClose={() => setPreviewOpen(false)}
      />
      {aiMode === 'draft' && (
        <Modal title="從題材起草" onClose={closeAi}>
          {aiError && <div className="notice error">{aiError}</div>}
          <AiWriteNotice ai={session?.ai} />
          {!draftPreview ? (
            <form onSubmit={(event) => {
              event.preventDefault();
              if (!aiWrites) return;
              void runAi(async () => {
                const result = await api.post<{ title: string; preheader: string; bodyHtml: string }>('/ai/draft', { brief });
                setDraftPreview(result);
              });
            }}>
              <label htmlFor="ai-brief">題材</label>
              <textarea id="ai-brief" required disabled={!aiWrites} value={brief} onChange={(event) => setBrief(event.target.value)} placeholder="這封信要跟讀者說什麼" />
              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <button className="btn primary" type="submit" disabled={aiBusy || !aiWrites}>{aiBusy ? '產生中…' : '產生預覽'}</button>
              </div>
            </form>
          ) : (
            <div>
              <p><strong>{draftPreview.title}</strong></p>
              <p className="muted">{draftPreview.preheader || '（沒有前導文字）'}</p>
              <div className="ai-html" dangerouslySetInnerHTML={{ __html: draftPreview.bodyHtml }} />
              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <button type="button" className="btn" onClick={() => setDraftPreview(null)}>重寫</button>
                <button type="button" className="btn primary" onClick={() => {
                  setTitle(draftPreview.title);
                  setPreheader(draftPreview.preheader);
                  setBodyHtml(draftPreview.bodyHtml);
                  setAiMode(null);
                }}>取代本文</button>
              </div>
            </div>
          )}
        </Modal>
      )}
      {aiMode === 'subjects' && (
        <Modal title="標題與前導" onClose={closeAi}>
          {aiError && <div className="notice error">{aiError}</div>}
          <AiWriteNotice ai={session?.ai} />
          {!subjectOptions ? (
            <button type="button" className="btn primary" disabled={aiBusy || !aiWrites} onClick={() => {
              if (!aiWrites) return;
              void runAi(async () => {
                const result = await api.post<{ options: { subject: string; preheader: string }[] }>('/ai/subjects', { title, bodyHtml });
                setSubjectOptions(result.options);
              });
            }}>{aiBusy ? '產生中…' : '依正文產生 3 組'}</button>
          ) : (
            <div className="ai-options">
              {subjectOptions.map((option) => (
                <button key={option.subject} type="button" className="ai-option" onClick={() => {
                  setTitle(option.subject);
                  setPreheader(option.preheader);
                  setAiMode(null);
                }}>
                  <strong>{option.subject}</strong>
                  <span className="muted">{option.preheader || '（沒有前導文字）'}</span>
                </button>
              ))}
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}

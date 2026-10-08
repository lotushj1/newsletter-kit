import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useOutletContext, useParams } from 'react-router-dom';
import { PreviewDialog } from '../components/PreviewDialog';
import { TiptapEditor } from '../components/TiptapEditor';
import { AiWriteNotice } from '../components/AiWriteNotice';
import { Modal } from '../components/Modal';
import { api, formatTime, STATUS_LABEL, type Campaign, type Folder, type Session } from '../api';

const LOCKED = ['sending', 'sent'];

export function CampaignEditor() {
  const { id = '' } = useParams();
  const session = useOutletContext<Session | null>();
  const aiWrites = Boolean(session?.ai.writes);
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [title, setTitle] = useState('');
  const [preheader, setPreheader] = useState('');
  const [bodyHtml, setBodyHtml] = useState('');
  const [folderId, setFolderId] = useState('');
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
      if (c.scheduledAt) setScheduleAt(c.scheduledAt.slice(0, 16));
      loaded.current = true;
    });
    void api.get<{ items: Folder[] }>('/folders').then((data) => setFolders(data.items));
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
      audienceTags: [],
      audienceFolderId: folderId,
    });
    setCampaign(updated);
    setSaveStatus('已自動儲存');
    hideStatus.current = window.setTimeout(() => {
      setSaveStatus((current) => (current === '已自動儲存' ? '' : current));
    }, 2000);
  }, [editable, id, title, preheader, bodyHtml, folderId]);

  useEffect(() => {
    if (!loaded.current || !editable) return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      void save().catch((err: Error) => setSaveStatus(err.message));
    }, 1200);
    return () => window.clearTimeout(timer.current);
  }, [title, preheader, bodyHtml, folderId, editable, save]);

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
        </div>
        {campaign.status === 'sent' && (
          <div className="card">
            <div>開信 {campaign.tracking.uniqueOpens}／{campaign.tracking.opens}</div>
            <div>點擊 {campaign.tracking.uniqueClicks}／{campaign.tracking.clicks}</div>
            <div>退訂 {campaign.tracking.unsubscribes ?? 0}</div>
            <div className="muted">寄出 {campaign.stats.sent}／{campaign.stats.total}</div>
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
                audienceTags: [],
                audienceFolderId: folderId,
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

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { PreviewDialog } from '../components/PreviewDialog';
import { TiptapEditor } from '../components/TiptapEditor';
import { api, formatTime, STATUS_LABEL, type Campaign, type CampaignTemplate, type Folder } from '../api';

const LOCKED = ['sending', 'sent'];

export function CampaignEditor() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
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
  const [savingTemplate, setSavingTemplate] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const loaded = useRef(false);
  const inspectHostRef = useRef<HTMLDivElement>(null);
  const [inspectingButton, setInspectingButton] = useState(false);

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
  }, [editable, id, title, preheader, bodyHtml, folderId]);

  useEffect(() => {
    if (!loaded.current || !editable) return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      void save().catch((err: Error) => setSaveStatus(err.message));
    }, 1200);
    return () => window.clearTimeout(timer.current);
  }, [title, preheader, bodyHtml, folderId, editable, save]);

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
            <label>前導文字</label>
            <input value={preheader} disabled={!editable} onChange={(e) => setPreheader(e.target.value)} placeholder="收件匣預覽那一行，可留空" />
          </div>
        </div>
        <TiptapEditor
          value={bodyHtml}
          onChange={setBodyHtml}
          editable={editable}
          inspectHost={inspectHostRef}
          onInspectingChange={setInspectingButton}
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
        <button
          type="button"
          className="btn"
          disabled={savingTemplate}
          onClick={() => {
            setSavingTemplate(true);
            setMessage('');
            void (editable ? save() : Promise.resolve())
              .then(() =>
                api.post<CampaignTemplate>(`/campaigns/${id}/template`, {
                  title,
                  preheader,
                  bodyHtml,
                }),
              )
              .then((created) => {
                navigate(`/brand/templates/${created.id}`);
              })
              .catch((err: Error) => {
                setMessage(err.message);
                setSavingTemplate(false);
              });
          }}
        >
          {savingTemplate ? '儲存中…' : '存成模板'}
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
    </div>
  );
}

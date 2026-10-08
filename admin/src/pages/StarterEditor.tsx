import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { EMPTY_STARTER_BODY } from '../../../src/core/campaign-starters';
import { api, type CampaignTemplate } from '../api';
import { TiptapEditor } from '../components/TiptapEditor';

export function StarterEditor() {
  const { id = 'new' } = useParams();
  const navigate = useNavigate();
  const isNew = id === 'new';
  const [item, setItem] = useState<CampaignTemplate | null>(isNew ? null : null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [title, setTitle] = useState('');
  const [preheader, setPreheader] = useState('');
  const [bodyHtml, setBodyHtml] = useState(EMPTY_STARTER_BODY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const loaded = useRef(false);

  const builtin = item?.builtin ?? false;
  const editable = isNew || !builtin;

  useEffect(() => {
    if (isNew) {
      loaded.current = true;
      return;
    }
    void api
      .get<CampaignTemplate>(`/campaign-templates/${id}`)
      .then((data) => {
        setItem(data);
        setName(data.name);
        setDescription(data.description);
        setTitle(data.title);
        setPreheader(data.preheader);
        setBodyHtml(data.bodyHtml);
        loaded.current = true;
      })
      .catch((err: Error) => setError(err.message));
  }, [id, isNew]);

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const payload = { name, description, title, preheader, bodyHtml };
      if (isNew) {
        const created = await api.post<CampaignTemplate>('/campaign-templates', payload);
        navigate(`/brand/templates/${created.id}`, { replace: true });
        setItem(created);
      } else {
        const updated = await api.patch<CampaignTemplate>(`/campaign-templates/${id}`, payload);
        setItem(updated);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '儲存失敗');
    } finally {
      setSaving(false);
    }
  };

  const copy = async () => {
    try {
      const copied = await api.post<CampaignTemplate>(`/campaign-templates/${id}/copy`);
      navigate(`/brand/templates/${copied.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : '複製失敗');
    }
  };

  if (!isNew && !item && !error) return <p className="muted" style={{ padding: 24 }}>載入中…</p>;

  return (
    <div className="editor-shell">
      <div className="editor-main">
        {error && <div className="notice error">{error}</div>}
        <p className="muted" style={{ margin: '0 0 12px' }}>
          <Link to="/campaigns">← 電子報</Link>
        </p>
        <input
          className="editor-title"
          value={name}
          disabled={!editable}
          onChange={(event) => setName(event.target.value)}
          placeholder="模板名稱"
        />
        <div className="editor-meta">
          <div>
            <label>說明</label>
            <input
              value={description}
              disabled={!editable}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="這封信適合什麼時候用"
            />
          </div>
          <div>
            <label>建立後的標題</label>
            <input
              value={title}
              disabled={!editable}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="電子報標題"
            />
          </div>
          <div>
            <label>前導文字</label>
            <input
              value={preheader}
              disabled={!editable}
              onChange={(event) => setPreheader(event.target.value)}
              placeholder="收件匣預覽那一行，可留空"
            />
          </div>
        </div>
        <TiptapEditor value={bodyHtml} onChange={setBodyHtml} editable={editable} />
      </div>
      <aside className="editor-side">
        <div>
          <p className="muted" style={{ margin: 0 }}>
            {builtin ? '內建模板只能查看。要改的話，先複製一份。' : '儲存後，會出現在「透過模板新增」。'}
          </p>
        </div>
        {editable ? (
          <button type="button" className="btn primary" disabled={saving} onClick={() => void save()}>
            {saving ? '儲存中…' : isNew ? '建立模板' : '儲存'}
          </button>
        ) : (
          <button type="button" className="btn primary" onClick={() => void copy()}>
            複製成我的模板
          </button>
        )}
      </aside>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { api, formatTime, STATUS_LABEL, type Campaign } from '../api';
import { ModalClose } from './ModalClose';

export function FromCampaignDialog({
  open,
  savingId,
  error,
  onClose,
  onPick,
}: {
  open: boolean;
  savingId: string | null;
  error: string;
  onClose: () => void;
  onPick: (campaign: Campaign) => void;
}) {
  const [items, setItems] = useState<Campaign[]>([]);
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!open) return;
    setLoadError('');
    setLoading(true);
    void api
      .get<{ items: Campaign[] }>('/campaigns?limit=50')
      .then((data) => setItems(data.items))
      .catch((err: Error) => setLoadError(err.message))
      .finally(() => setLoading(false));
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
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal-root" role="presentation">
      <button type="button" className="modal-backdrop" aria-label="關閉" onClick={onClose} />
      <div className="modal-panel compact from-campaign-panel" role="dialog" aria-modal="true" aria-labelledby="from-campaign-title">
        <header className="modal-header">
          <div>
            <h2 id="from-campaign-title">從電子報新增</h2>
            <p className="muted">選一封過去的信，標題與內文會複製成模板。原信件不會被改。</p>
          </div>
          <ModalClose onClick={onClose} />
        </header>
        <div className="modal-body">
          {(error || loadError) && <div className="notice error">{error || loadError}</div>}
          {loading ? (
            <p className="muted">載入電子報中…</p>
          ) : items.length === 0 && !loadError ? (
            <p className="muted">還沒有電子報可以轉成模板。</p>
          ) : (
            <div className="from-campaign-list">
              {items.map((campaign) => (
                <button
                  key={campaign.id}
                  type="button"
                  className="card template-card"
                  disabled={savingId !== null}
                  onClick={() => onPick(campaign)}
                >
                  <strong>{campaign.title}</strong>
                  <p className="muted">
                    {STATUS_LABEL[campaign.status] ?? campaign.status}
                    {' · '}
                    {campaign.status === 'sent' && campaign.sentAt
                      ? `寄出 ${formatTime(campaign.sentAt)}`
                      : `編輯 ${formatTime(campaign.updatedAt)}`}
                  </p>
                  {savingId === campaign.id ? <p className="muted">儲存中…</p> : null}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

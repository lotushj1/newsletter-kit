import { useEffect } from 'react';
import { ModalClose } from './ModalClose';

export function PreviewDialog({
  open,
  html,
  title,
  loading,
  onClose,
}: {
  open: boolean;
  html: string;
  title: string;
  loading: boolean;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) return;
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
      <button type="button" className="modal-backdrop" aria-label="關閉預覽" onClick={onClose} />
      <div className="modal-panel" role="dialog" aria-modal="true" aria-labelledby="preview-title">
        <header className="modal-header">
          <h2 id="preview-title">{title || '預覽'}</h2>
          <ModalClose label="關閉預覽" onClick={onClose} />
        </header>
        <div className="modal-body">
          {loading && !html ? (
            <p className="muted" style={{ padding: 24, textAlign: 'center' }}>
              產生預覽中…
            </p>
          ) : (
            <iframe className="preview-frame" title="電子報預覽" srcDoc={html} />
          )}
        </div>
      </div>
    </div>
  );
}

import { useEffect, type ReactNode } from 'react';
import { ModalClose } from './ModalClose';

export function Modal({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
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

  return (
    <div className="modal-root" role="presentation">
      <button type="button" className="modal-backdrop" aria-label="關閉" onClick={onClose} />
      <div className={`modal-panel ${wide ? 'wide' : 'compact'}`} role="dialog" aria-modal="true" aria-labelledby="ai-dialog-title">
        <header className="modal-header">
          <h2 id="ai-dialog-title">{title}</h2>
          <ModalClose onClick={onClose} />
        </header>
        <div className="modal-body form">{children}</div>
      </div>
    </div>
  );
}

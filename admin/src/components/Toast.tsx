import { CircleAlert, X } from 'lucide-react';

export function Toast({
  title,
  body,
  onClose,
}: {
  title: string;
  body?: string;
  onClose: () => void;
}) {
  return (
    <div className="ui-toast" role="status" aria-live="polite">
      <span className="ui-toast-mark" aria-hidden="true">
        <CircleAlert size={13} strokeWidth={2} />
      </span>
      <div className="ui-toast-copy">
        <strong>{title}</strong>
        {body ? <p>{body}</p> : null}
      </div>
      <button type="button" className="icon" aria-label="關閉" onClick={onClose}>
        <X size={14} strokeWidth={2} />
      </button>
    </div>
  );
}

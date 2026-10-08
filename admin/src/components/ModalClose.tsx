import { X } from 'lucide-react';

export function ModalClose({
  onClick,
  label = '關閉',
}: {
  onClick: () => void;
  label?: string;
}) {
  return (
    <button type="button" className="icon modal-close" aria-label={label} onClick={onClick}>
      <X size={16} strokeWidth={2} />
    </button>
  );
}

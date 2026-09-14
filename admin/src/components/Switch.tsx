export function Switch({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  const label = checked ? '啟用' : '停用';
  return (
    <label className={`ui-switch ${checked ? 'on' : ''}`}>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="ui-switch-track" aria-hidden="true" />
      <span className="ui-switch-text">{label}</span>
    </label>
  );
}

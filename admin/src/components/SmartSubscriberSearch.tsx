import { useEffect, useId, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import {
  defaultSuggestionIndex,
  subscriberSearchSuggestions,
  type SubscriberSearchSuggestion,
} from './subscriber-search';

export function SmartSubscriberSearch({
  value,
  onChange,
  tags,
  folders,
  ai,
  busy,
  onApply,
  onAskAi,
}: {
  value: string;
  onChange: (value: string) => void;
  tags: string[];
  folders: { id: string; name: string }[];
  ai: boolean;
  busy: boolean;
  onApply: (suggestion: SubscriberSearchSuggestion) => void;
  onAskAi: (prompt: string) => Promise<boolean>;
}) {
  const listId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const items = subscriberSearchSuggestions(value, { tags, folders }, { ai });
  const itemKey = `${value.trim()}|${items.map((item) => `${item.id}:${item.exact ? 1 : 0}`).join('|')}`;
  const [activeKey, setActiveKey] = useState(itemKey);
  if (activeKey !== itemKey) {
    setActiveKey(itemKey);
    setActive(defaultSuggestionIndex(items));
  }

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (wrapRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open]);

  const choose = (item: SubscriberSearchSuggestion) => {
    if (item.kind === 'ai') {
      if (busy || value.trim().length < 2) return;
      void onAskAi(value.trim()).then((applied) => {
        if (applied) setOpen(false);
      });
      return;
    }
    onApply(item);
    setOpen(false);
  };

  return (
    <div className={`smart-search${ai ? ' has-ask' : ''}`} ref={wrapRef}>
      <input
        type="search"
        role="combobox"
        aria-label="搜尋名單"
        aria-expanded={open && items.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && items[active] ? `${listId}-${items[active].id}` : undefined}
        aria-busy={busy}
        placeholder={ai ? '搜尋 Email、名稱，或用一句話找人' : '搜尋 Email 或名稱'}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
        }}
        onFocus={() => {
          if (value.trim()) setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && items.length > 0) {
            event.preventDefault();
            if (!open) {
              setOpen(true);
              return;
            }
            setActive((current) => (current + 1) % items.length);
            return;
          }
          if (event.key === 'ArrowUp' && items.length > 0) {
            event.preventDefault();
            if (!open) {
              setOpen(true);
              return;
            }
            setActive((current) => (current - 1 + items.length) % items.length);
            return;
          }
          if (event.key === 'Enter' && open && items[active]) {
            event.preventDefault();
            choose(items[active]);
            return;
          }
          if (event.key === 'Escape') setOpen(false);
        }}
      />
      {ai && (
        <button
          type="button"
          className="smart-search-ask"
          aria-label="用 AI 找"
          disabled={busy || value.trim().length < 2}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            if (value.trim().length < 2) return;
            setOpen(true);
            void onAskAi(value.trim()).then((applied) => {
              if (applied) setOpen(false);
            });
          }}
        >
          <Sparkles size={16} />
        </button>
      )}
      {open && items.length > 0 && (
        <div id={listId} className="smart-search-menu" role="listbox">
          {items.map((item, index) => (
            <button
              key={item.id}
              id={`${listId}-${item.id}`}
              type="button"
              role="option"
              aria-selected={index === active}
              disabled={item.kind === 'ai' && busy}
              onMouseEnter={() => setActive(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(item)}
            >
              {item.kind === 'ai' && busy ? '理解中…' : item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

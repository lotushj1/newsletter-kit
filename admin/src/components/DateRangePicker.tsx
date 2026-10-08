import { useEffect, useMemo, useRef, useState } from 'react';

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function toYmd(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function parseYmd(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year ?? 0, (month ?? 1) - 1, day ?? 1);
}

function formatDay(value: string): string {
  const date = parseYmd(value);
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

function labelFor(from: string, to: string): string {
  if (!from && !to) return '日期範圍';
  if (from && to && from !== to) return `${formatDay(from)} – ${formatDay(to)}`;
  return formatDay(from || to);
}

function monthCells(year: number, month: number): Array<string | null> {
  const first = new Date(year, month, 1);
  const padStart = (first.getDay() + 6) % 7;
  const lastDay = new Date(year, month + 1, 0).getDate();
  const cells: Array<string | null> = [];
  for (let i = 0; i < padStart; i += 1) cells.push(null);
  for (let day = 1; day <= lastDay; day += 1) cells.push(toYmd(new Date(year, month, day)));
  return cells;
}

function inRange(day: string, start: string, end: string): boolean {
  if (!start || !end) return false;
  const lo = start < end ? start : end;
  const hi = start < end ? end : start;
  return day >= lo && day <= hi;
}

export function DateRangePicker({
  from,
  to,
  onChange,
}: {
  from: string;
  to: string;
  onChange: (next: { from: string; to: string }) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(() => (from ? parseYmd(from) : new Date()));
  const [draft, setDraft] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);

  const cells = useMemo(
    () => monthCells(cursor.getFullYear(), cursor.getMonth()),
    [cursor],
  );

  useEffect(() => {
    if (!open) return;
    setDraft(null);
    setHover(null);
    setCursor(from ? parseYmd(from) : new Date());
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, from]);

  const previewStart = draft ?? from;
  const previewEnd = draft ? hover ?? draft : to;

  const pick = (day: string) => {
    if (!draft) {
      setDraft(day);
      setHover(day);
      return;
    }
    const start = draft < day ? draft : day;
    const end = draft < day ? day : draft;
    onChange({ from: start, to: end });
    setDraft(null);
    setOpen(false);
  };

  return (
    <div className="date-range" ref={rootRef}>
      <button
        type="button"
        className={`date-range-trigger ${from || to ? 'has-value' : ''}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="日期範圍"
        onClick={() => setOpen((current) => !current)}
      >
        {labelFor(from, to)}
      </button>
      {(from || to) && (
        <button
          type="button"
          className="date-range-clear"
          aria-label="清除日期"
          onClick={() => onChange({ from: '', to: '' })}
        >
          ×
        </button>
      )}
      {open && (
        <div className="date-range-pop" role="dialog" aria-label="選擇日期範圍">
          <div className="date-range-nav">
            <button
              type="button"
              className="icon"
              aria-label="上個月"
              onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}
            >
              ‹
            </button>
            <strong>
              {cursor.getFullYear()}年{cursor.getMonth() + 1}月
            </strong>
            <button
              type="button"
              className="icon"
              aria-label="下個月"
              onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}
            >
              ›
            </button>
          </div>
          <div className="date-range-week">
            {WEEKDAYS.map((day) => (
              <span key={day}>{day}</span>
            ))}
          </div>
          <div className="date-range-grid">
            {cells.map((day, index) =>
              day ? (
                <button
                  key={day}
                  type="button"
                  className={[
                    'date-range-day',
                    inRange(day, previewStart, previewEnd) ? 'in-range' : '',
                    day === previewStart || day === previewEnd ? 'edge' : '',
                  ].join(' ')}
                  onMouseEnter={() => draft && setHover(day)}
                  onClick={() => pick(day)}
                >
                  {Number(day.slice(-2))}
                </button>
              ) : (
                <span key={`empty-${index}`} />
              ),
            )}
          </div>
          <p className="muted date-range-hint">{draft ? '再選結束日' : '先選開始日，再選結束日'}</p>
        </div>
      )}
    </div>
  );
}

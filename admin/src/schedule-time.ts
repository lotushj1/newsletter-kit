/**
 * 排程時間在 `<input type="datetime-local">`（沒有時區的牆上時間）與 ISO（UTC）之間的轉換。
 *
 * 不能用 `iso.slice(0, 16)`：那是 UTC 的鐘點，在台灣會顯示早 8 小時，再存一次就真的提早 8 小時寄出。
 * timeZone 省略時用瀏覽器所在時區（跟 datetime-local 的解讀一致）；測試可傳 IANA 時區名稱。
 */

const PARTS = {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
} as const;

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function wallClock(date: Date, timeZone?: string): WallClock {
  const parts = new Intl.DateTimeFormat('en-US', { ...PARTS, timeZone }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
  };
}

/** 這個時刻在該時區比 UTC 快多少毫秒（台灣 +8 小時）。 */
export function timeZoneOffsetMs(date: Date, timeZone?: string): number {
  const w = wallClock(date, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** ISO → datetime-local 的值（該時區的牆上時間，到分鐘）。讀不懂回空字串。 */
export function isoToLocalInput(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const w = wallClock(date, timeZone);
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}`;
}

/** datetime-local 的值（該時區的牆上時間）→ ISO（UTC）。格式不對回 null。 */
export function localInputToIso(value: string, timeZone?: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) return null;
  const [y, mo, d, h, mi] = match.slice(1, 6).map(Number) as [number, number, number, number, number];
  const s = match[6] ? Number(match[6]) : 0;
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  // 2 月 30 日、25 點這類不存在的日期時間：Date.UTC 會自動進位，這裡直接拒絕。
  const check = new Date(guess);
  if (
    Number.isNaN(guess) ||
    check.getUTCFullYear() !== y || check.getUTCMonth() + 1 !== mo || check.getUTCDate() !== d ||
    check.getUTCHours() !== h || check.getUTCMinutes() !== mi
  ) {
    return null;
  }
  // 先用「把牆上時間當 UTC」的時刻估時差，再用換算後的時刻重估一次（日光節約切換的那天時差會變）。
  const first = guess - timeZoneOffsetMs(new Date(guess), timeZone);
  const second = guess - timeZoneOffsetMs(new Date(first), timeZone);
  const wanted = `${pad(y, 4)}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}`;
  const exact = [second, first].find((t) => isoToLocalInput(new Date(t).toISOString(), timeZone) === wanted);
  // 撥快那一小時不存在的時間（例如 02:30）：跟瀏覽器一樣往後算成撥快後的時間。
  return new Date(exact ?? Math.max(first, second)).toISOString();
}

/** 目前用來解讀排程時間的時區名稱（例如 Asia/Taipei）。 */
export function timeZoneName(timeZone?: string): string {
  return timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
}

/** 例如「UTC+08:00」。 */
export function utcOffsetLabel(date: Date, timeZone?: string): string {
  const minutes = Math.round(timeZoneOffsetMs(date, timeZone) / 60_000);
  const sign = minutes < 0 ? '−' : '+';
  const abs = Math.abs(minutes);
  return `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** 例如「Asia/Taipei（UTC+08:00）」。 */
export function timeZoneLabel(at: Date = new Date(), timeZone?: string): string {
  return `${timeZoneName(timeZone)}（${utcOffsetLabel(at, timeZone)}）`;
}

/**
 * 寄出時間的完整說明，例如「2026-11-21 10:00（Asia/Taipei，UTC+08:00）＝ 2026-11-21 02:00 UTC」。
 * 讀不懂回空字串。
 */
export function describeSendTime(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const local = isoToLocalInput(iso, timeZone).replace('T', ' ');
  const utc = isoToLocalInput(iso, 'UTC').replace('T', ' ');
  return `${local}（${timeZoneName(timeZone)}，${utcOffsetLabel(date, timeZone)}）＝ ${utc} UTC`;
}

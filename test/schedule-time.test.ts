import { describe, expect, it } from 'vitest';
import {
  describeSendTime,
  isoToLocalInput,
  localInputToIso,
  timeZoneLabel,
  utcOffsetLabel,
} from '../admin/src/schedule-time.ts';

describe('排程時間：datetime-local ↔ ISO', () => {
  it('台灣（UTC+8）：存的是 02:00Z，輸入框顯示 10:00，不是 UTC 的 02:00', () => {
    expect(isoToLocalInput('2026-11-21T02:00:00.000Z', 'Asia/Taipei')).toBe('2026-11-21T10:00');
    expect(localInputToIso('2026-11-21T10:00', 'Asia/Taipei')).toBe('2026-11-21T02:00:00.000Z');
  });

  it('來回轉換不會位移：重新載入再存一次，寄出時間不變', () => {
    let iso = '2026-11-21T02:00:00.000Z';
    for (let i = 0; i < 3; i += 1) {
      iso = localInputToIso(isoToLocalInput(iso, 'Asia/Taipei'), 'Asia/Taipei')!;
    }
    expect(iso).toBe('2026-11-21T02:00:00.000Z');
  });

  it('跨日：台灣 01:30 是前一天的 17:30Z', () => {
    expect(localInputToIso('2026-11-21T01:30', 'Asia/Taipei')).toBe('2026-11-20T17:30:00.000Z');
    expect(isoToLocalInput('2026-11-20T17:30:00.000Z', 'Asia/Taipei')).toBe('2026-11-21T01:30');
  });

  it('負時差與非整點時差也對（紐約、印度）', () => {
    expect(localInputToIso('2026-11-21T10:00', 'America/New_York')).toBe('2026-11-21T15:00:00.000Z');
    expect(localInputToIso('2026-07-01T10:00', 'America/New_York')).toBe('2026-07-01T14:00:00.000Z');
    expect(localInputToIso('2026-11-21T10:00', 'Asia/Kolkata')).toBe('2026-11-21T04:30:00.000Z');
    expect(isoToLocalInput('2026-11-21T04:30:00.000Z', 'Asia/Kolkata')).toBe('2026-11-21T10:00');
  });

  it('日光節約：撥快那一小時不存在的時間往後算，其他時間照常', () => {
    // 2026-03-08 紐約 02:00 撥快到 03:00
    expect(localInputToIso('2026-03-08T01:30', 'America/New_York')).toBe('2026-03-08T06:30:00.000Z');
    expect(localInputToIso('2026-03-08T03:30', 'America/New_York')).toBe('2026-03-08T07:30:00.000Z');
    expect(localInputToIso('2026-03-08T02:30', 'America/New_York')).toBe('2026-03-08T07:30:00.000Z');
  });

  it('格式不對或日期不存在回 null／空字串', () => {
    expect(localInputToIso('', 'Asia/Taipei')).toBeNull();
    expect(localInputToIso('2026-11-21', 'Asia/Taipei')).toBeNull();
    expect(localInputToIso('2026-02-30T10:00', 'Asia/Taipei')).toBeNull();
    expect(isoToLocalInput(null)).toBe('');
    expect(isoToLocalInput('not a date')).toBe('');
  });

  it('顯示時區與確切寄出時間', () => {
    const at = new Date('2026-11-21T02:00:00.000Z');
    expect(utcOffsetLabel(at, 'Asia/Taipei')).toBe('UTC+08:00');
    expect(utcOffsetLabel(at, 'America/New_York')).toBe('UTC−05:00');
    expect(timeZoneLabel(at, 'Asia/Taipei')).toBe('Asia/Taipei（UTC+08:00）');
    expect(describeSendTime('2026-11-21T02:00:00.000Z', 'Asia/Taipei')).toBe(
      '2026-11-21 10:00（Asia/Taipei，UTC+08:00）＝ 2026-11-21 02:00 UTC',
    );
  });
});

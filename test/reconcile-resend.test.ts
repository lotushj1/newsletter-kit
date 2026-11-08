import { describe, expect, it } from 'vitest';
import { maskCompatible, parseMask, reconcile, type PortalyEmail } from '../scripts/reconcile-resend.js';
import type { MemorySnapshot } from '../src/store/memory-store.js';

const mask = (email: string) => `${email.split('@')[0]!.slice(0, 2)}***@${email.split('@')[1]}`;

function baseline(emails: string[], extra: Partial<MemorySnapshot> = {}): MemorySnapshot {
  return {
    subscribers: emails.map((email, i) => ({
      id: `sub_${i}`,
      email,
      status: 'subscribed',
      tags: [],
      createdAt: `2026-10-01T00:00:${String(i).padStart(2, '0')}.000Z`,
    })),
    campaigns: [{ id: 'cmp_12', slug: '12', title: '第 12 期', subject: '第 12 期', bodyHtml: '<p>x</p>', status: 'scheduled', audienceTags: [], createdAt: 'x', updatedAt: 'x' } as never],
    deliveries: [],
    events: [],
    sequences: [],
    sequenceSteps: [],
    enrollments: [],
    folders: [],
    templates: [],
    settings: {},
    campaignStarters: [],
    ...extra,
  };
}

function portalySends(recipients: string[], batchSize = 20, statuses: Record<string, string> = {}): PortalyEmail[] {
  return recipients.map((email, i) => ({
    id: `emsg_${i}`,
    subject: '[週報 #12] 標題',
    batchId: `ebat_${Math.floor(i / batchSize)}`,
    createdAt: new Date(Date.UTC(2026, 10, 4, 12, 0, Math.floor(i / batchSize))).toISOString(),
    tags: [{ name: 'ref', value: `dlv_unknown_${i}` }],
    recipients: [{ email: mask(email), status: statuses[email] ?? 'delivered' }],
  }));
}

// 每人前兩碼＋網域都不同（遮罩不撞名）
const unique = Array.from({ length: 60 }, (_, i) => `${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}user@d${i}.example`);
// 很多人同開頭同網域（遮罩大量撞名，跟真實資料一樣）
const colliding = Array.from({ length: 60 }, (_, i) => `${['ch', 'al', 'ke'][i % 3]}${i}user@gmail.com`);
const run = (portaly: PortalyEmail[], people: string[]) =>
  reconcile({ portaly, baseline: baseline(people), campaignId: 'cmp_12', subjectPrefix: '[週報 #12]' });

describe('補寄對帳工具', () => {
  it('遮罩比對以可見前綴＋網域判斷', () => {
    expect(maskCompatible('alice@gmail.com', parseMask('al***@gmail.com'))).toBe(true);
    expect(maskCompatible('alice@yahoo.com', parseMask('al***@gmail.com'))).toBe(false);
    expect(maskCompatible('bob@gmail.com', parseMask('al***@gmail.com'))).toBe(false);
  });

  it('遮罩不撞名時：寄出的 40 人為已收到，其餘 20 人可補寄', async () => {
    const result = await run(portalySends(unique.slice(0, 40)), unique);
    expect(result.received).toHaveLength(40);
    expect(result.resendable.map((r) => r.email).sort()).toEqual(unique.slice(40).sort());
    expect(result.unknown).toHaveLength(0);
  });

  it('遮罩大量撞名時不硬判：同組人數多於封數一律狀態不明，只有完全沒信對得上的人可補寄', async () => {
    const people = [...colliding, 'zz1@gmail.com', 'zz2@gmail.com'];
    const result = await run(portalySends(colliding.slice(0, 40)), people);
    expect(result.received).toHaveLength(0);
    expect(result.resendable.map((r) => r.email).sort()).toEqual(['zz1@gmail.com', 'zz2@gmail.com']);
    expect(result.unknown).toHaveLength(60);
    // 順序推測只是標註
    expect(result.unknown.find((u) => u.email === colliding[0])?.presumption).toMatch(/可能已收到/);
    expect(result.unknown.find((u) => u.email === colliding[59])?.presumption).toMatch(/可能未收到/);
  });

  it('軟退信、硬退信的人列為狀態不明，不算已收到也不補寄', async () => {
    const sent = unique.slice(0, 40);
    const result = await run(portalySends(sent, 20, { [sent[3]!]: 'soft_bounced', [sent[7]!]: 'bounced' }), unique);
    expect(result.received).toHaveLength(38);
    expect(result.unknown.map((u) => u.email).sort()).toEqual([sent[3], sent[7]].sort());
    expect(result.resendable).toHaveLength(20);
  });

  it('安全性：任何實際收到信的人都不會被列為可補寄（順序被打亂也一樣）', async () => {
    for (const people of [unique, colliding]) {
      const shuffled = [...people.slice(0, 20), ...people.slice(45, 60), ...people.slice(20, 25)];
      const result = await run(portalySends(shuffled), people);
      for (const person of result.resendable) expect(shuffled).not.toContain(person.email);
    }
  });

  it('寄送對象有備份名單外的人（備份後才訂閱）時列入 caveats，且不影響安全性', async () => {
    const result = await run(portalySends([...unique.slice(0, 19), 'newbie@late.example']), unique);
    expect(result.unmatchedPortalySends).toBe(1);
    expect(result.resendable.map((r) => r.email)).not.toContain('newbie@late.example');
  });

  it('順序推定：位置完全對齊才 verified，推定名單與正式可補寄名單分開', async () => {
    const people = [...colliding, 'zz1@gmail.com'];
    const ok = await run(portalySends(colliding.slice(0, 40)), people);
    expect(ok.orderCheck.verified).toBe(true);
    expect(ok.resendable.map((r) => r.email)).toEqual(['zz1@gmail.com']);
    expect(ok.orderCheck.presumedResendable.map((r) => r.email)).toEqual(colliding.slice(40));

    const shifted = colliding.filter((_, i) => i !== 1); // 第 2 人寄送前退訂 → 位置位移
    const bad = await run(portalySends(shifted.slice(0, 40)), people);
    expect(bad.orderCheck.verified).toBe(false);
    expect(bad.orderCheck.presumedResendable).toHaveLength(0);
  });

  it('沒有清空前的名單備份時不判定任何人', async () => {
    const result = await reconcile({ portaly: portalySends(unique.slice(0, 20)), campaignId: 'cmp_12', subjectPrefix: '[週報 #12]' });
    expect(result.method).toBe('portaly_only');
    expect(result.resendable).toHaveLength(0);
    expect(result.received).toHaveLength(0);
  });
});

/**
 * 補寄對帳（唯讀、離線）：不連任何服務、不寫正式資料、不寄信。
 * 寄送紀錄遺失時，用清空前的名單備份與 Portaly 寄送紀錄判斷誰可以補寄。
 *
 * 用法：
 *   npx tsx scripts/reconcile-resend.ts \
 *     --portaly portaly-emails.json \
 *     --baseline insforge-backup.sql.gz   # 或 nk_snapshots 的 payload JSON
 *     --campaign <campaign id> \
 *     --subject "<信件主旨開頭>" \
 *     --out ./reconcile-out
 *
 * 判定規則（狀態不明的一律不補寄）：
 * - 已收到（不可補寄）：寄送紀錄 id 直接對得上；或同一組遮罩（前兩碼＋網域）的
 *   受眾人數與 Portaly 封數相等且全部 delivered。accepted 但不是 delivered 的列入狀態不明。
 * - 可補寄：Portaly 沒有任何一封這期信件的遮罩地址對得上他（不靠寄送順序也成立）。
 * - 狀態不明：其餘全部。寄送順序的推測只寫在 presumption 欄供參考。
 * - 排除：退訂、退信、檢舉、排除名單、非訂閱狀態——不論有沒有收到都不補寄。
 * 未開信不等於沒收到，這個工具完全不使用開信資料做判斷。
 */
import { gunzipSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { selectAudience } from '../src/services/audience.js';
import { isSuppressed } from '../src/services/suppression.js';
import { MemoryStore, type MemorySnapshot } from '../src/store/memory-store.js';
import type { Campaign, Subscriber } from '../src/store/types.js';
import type { ServiceContext } from '../src/services/context.js';

export interface PortalyEmail {
  id: string;
  subject: string;
  batchId?: string | null;
  createdAt: string;
  sentAt?: string | null;
  tags?: { name: string; value: string }[];
  recipients: { email: string; status: string }[];
}

export interface Classified {
  email: string;
  subscriberId?: string;
  reason: string;
  providerMessageId?: string;
  batch?: number;
  /** 依寄送順序的推測，只供人工參考，不作為補寄依據。 */
  presumption?: string;
}

export interface ReconcileResult {
  method: 'delivery_ids' | 'mask_groups' | 'portaly_only';
  portaly: { sends: number; batches: number; delivered: number; nonDelivered: Record<string, number> };
  audience: { size: number; note?: string };
  received: Classified[];
  resendable: Classified[];
  unknown: Classified[];
  excluded: Classified[];
  unmatchedPortalySends: number;
  /**
   * 第二層（推定）：假設舊程式依名單順序寄送，檢查重建名單的前 N 人能否與 Portaly
   * 每一批「位置完全對齊」地配對。全部對齊才算 verified；即使 verified 也只是推定，
   * 依此多出來的可補寄名單必須經人工核准，不會進入正式的可補寄清單。
   */
  orderCheck: {
    verified: boolean;
    firstMismatchBatch?: number;
    presumedResendable: Classified[];
  };
  caveats: string[];
}

// ── 讀檔 ────────────────────────────────────────────────

/** 從 pg_dump 的 COPY 區塊取出 nk_snapshots 的 default 列。 */
export function payloadFromSqlDump(sql: string): MemorySnapshot {
  const start = sql.indexOf('COPY public.nk_snapshots (');
  if (start < 0) throw new Error('備份檔裡找不到 nk_snapshots 資料');
  const header = sql.slice(start, sql.indexOf('\n', start));
  const columns = header.slice(header.indexOf('(') + 1, header.indexOf(')')).split(',').map((c) => c.trim());
  const body = sql.slice(sql.indexOf('\n', start) + 1, sql.indexOf('\n\\.', start));
  for (const line of body.split('\n')) {
    const cells = line.split('\t').map(unescapeCopy);
    const row = Object.fromEntries(columns.map((c, i) => [c, cells[i]]));
    if (row.id === 'default') return JSON.parse(row.payload!) as MemorySnapshot;
  }
  throw new Error('備份檔裡找不到 nk_snapshots 的 default 列');
}

function unescapeCopy(value: string): string {
  return value.replace(/\\(.)/g, (_, ch: string) =>
    ({ t: '\t', n: '\n', r: '\r', b: '\b', f: '\f', v: '\v', '\\': '\\' })[ch] ?? ch,
  );
}

export function loadBaseline(path: string): MemorySnapshot {
  const raw = readFileSync(path);
  const text = path.endsWith('.gz') ? gunzipSync(raw).toString('utf8') : raw.toString('utf8');
  if (path.endsWith('.sql') || path.endsWith('.sql.gz')) return payloadFromSqlDump(text);
  const parsed = JSON.parse(text) as unknown;
  if (Array.isArray(parsed)) return (parsed.find((r) => (r as { id?: string }).id === 'default') as { payload: MemorySnapshot }).payload;
  return parsed as MemorySnapshot;
}

// ── 遮罩比對 ─────────────────────────────────────────────

interface Mask {
  prefix: string;
  domain: string;
}

export function parseMask(masked: string): Mask {
  const [local = '', domain = ''] = masked.toLowerCase().split('@');
  return { prefix: local.replace(/\*+$/, ''), domain };
}

export function maskCompatible(email: string, mask: Mask): boolean {
  const [local = '', domain = ''] = email.toLowerCase().split('@');
  return domain === mask.domain && mask.prefix.length > 0 && local.startsWith(mask.prefix);
}

/** 二分圖完美配對（每批 20×20，用增廣路徑就夠）。回傳 emailIndex → maskIndex，失敗回 null。 */
export function perfectMatch(emails: string[], masks: Mask[]): number[] | null {
  if (emails.length !== masks.length) return null;
  const owner = new Array<number>(masks.length).fill(-1);
  const tryAssign = (e: number, seen: boolean[]): boolean => {
    for (let m = 0; m < masks.length; m += 1) {
      if (seen[m] || !maskCompatible(emails[e]!, masks[m]!)) continue;
      seen[m] = true;
      if (owner[m] === -1 || tryAssign(owner[m]!, seen)) {
        owner[m] = e;
        return true;
      }
    }
    return false;
  };
  for (let e = 0; e < emails.length; e += 1) {
    if (!tryAssign(e, new Array<boolean>(masks.length).fill(false))) return null;
  }
  const result = new Array<number>(emails.length);
  owner.forEach((e, m) => {
    result[e] = m;
  });
  return result;
}

// ── 主流程 ──────────────────────────────────────────────

class SnapshotStore extends MemoryStore {
  load(snapshot: MemorySnapshot): void {
    this.loadSnapshot(snapshot);
  }
}

export async function reconcile(input: {
  portaly: PortalyEmail[];
  baseline?: MemorySnapshot | undefined;
  campaignId: string;
  subjectPrefix: string;
}): Promise<ReconcileResult> {
  const caveats: string[] = [];
  const sends = input.portaly
    .filter((e) => e.subject.startsWith(input.subjectPrefix))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const refOf = (e: PortalyEmail) => e.tags?.find((t) => t.name === 'ref')?.value;
  const batchOrder = [...new Set(sends.map((e) => e.batchId ?? `single:${e.id}`))];
  const nonDelivered: Record<string, number> = {};
  for (const e of sends) {
    const status = e.recipients[0]?.status ?? 'unknown';
    if (status !== 'delivered') nonDelivered[status] = (nonDelivered[status] ?? 0) + 1;
  }
  const portalySummary = {
    sends: sends.length,
    batches: batchOrder.length,
    delivered: sends.filter((e) => e.recipients[0]?.status === 'delivered').length,
    nonDelivered,
  };

  const empty = (method: ReconcileResult['method'], note: string): ReconcileResult => ({
    method,
    portaly: portalySummary,
    audience: { size: 0, note },
    received: [],
    resendable: [],
    unknown: [],
    excluded: [],
    unmatchedPortalySends: sends.length,
    orderCheck: { verified: false, presumedResendable: [] },
    caveats: [...caveats, note],
  });

  if (!input.baseline) {
    return empty('portaly_only', '沒有清空前的名單備份，無法判定任何人的補寄資格');
  }

  const store = new SnapshotStore();
  store.load(input.baseline);
  // 受眾與排除名單只讀 store；不建立寄信 adapter，這個工具不可能寄信。
  const ctx = { store } as unknown as ServiceContext;
  const campaign = (input.baseline.campaigns ?? []).find((c) => c.id === input.campaignId) as Campaign | undefined;
  if (!campaign) return empty('portaly_only', `備份裡找不到電子報 ${input.campaignId}，無法重建受眾`);

  const excluded: Classified[] = [];
  for (const s of input.baseline.subscribers ?? []) {
    if (s.status !== 'subscribed') excluded.push({ email: s.email, subscriberId: s.id, reason: `名單狀態為 ${s.status}` });
    else if (s.meta?.suppressedReason || (await isSuppressed(ctx, s.email))) {
      excluded.push({ email: s.email, subscriberId: s.id, reason: '排除名單（退信／檢舉／退訂）' });
    }
  }
  const audience: Subscriber[] = await selectAudience(ctx, campaign);

  const received = new Map<string, Classified>();
  const unknownReasons = new Map<string, string>();
  const matchedSends = new Set<string>();

  // 1. 備份裡就有這期的寄送紀錄：直接用 delivery id 對
  const deliveries = (input.baseline.deliveries ?? []).filter((d) => d.campaignId === input.campaignId);
  const byDelivery = new Map(deliveries.map((d) => [d.id, d]));
  let method: ReconcileResult['method'] = 'mask_groups';
  for (const e of sends) {
    const ref = refOf(e);
    const delivery = ref ? byDelivery.get(ref) : undefined;
    if (!delivery) continue;
    method = 'delivery_ids';
    matchedSends.add(e.id);
    const status = e.recipients[0]?.status;
    if (status === 'delivered') {
      received.set(delivery.email.toLowerCase(), { email: delivery.email, subscriberId: delivery.subscriberId, reason: 'Portaly delivered（寄送紀錄 id 相符）', providerMessageId: e.id });
    } else {
      unknownReasons.set(delivery.email.toLowerCase(), `Portaly 狀態 ${status ?? '未知'}（已交寄但未確認送達）`);
    }
  }

  // 2. 其餘不靠寄送順序：以「遮罩相容」建二分圖，按連通分量判定。
  //    遮罩只露前兩碼＋網域，撞名很多，所以只有下列情況下結論：
  //    - 分量裡沒有任何 Portaly 信 → 那些人一定沒收到 → 可補寄
  //    - 人數 = 信數、能完美配對、全部 delivered → 那些人都收到了
  //    - 其他 → 狀態不明（寄送順序的推測只寫在 presumption 欄，不作為補寄依據）
  const remaining = sends.filter((e) => !matchedSends.has(e.id));
  const sendMasks = remaining.map((e) => parseMask(e.recipients[0]?.email ?? ''));
  const pool = audience.filter((s) => !received.has(s.email.toLowerCase()) && !unknownReasons.has(s.email.toLowerCase()));
  const parent = Array.from({ length: pool.length + remaining.length }, (_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x]!)));
  const union = (a: number, b: number) => {
    parent[find(a)] = find(b);
  };
  pool.forEach((person, i) => {
    sendMasks.forEach((mask, j) => {
      if (maskCompatible(person.email, mask)) union(i, pool.length + j);
    });
  });
  const components = new Map<number, { persons: number[]; sends: number[] }>();
  for (let x = 0; x < parent.length; x += 1) {
    const root = find(x);
    const group = components.get(root) ?? { persons: [], sends: [] };
    if (x < pool.length) group.persons.push(x);
    else group.sends.push(x - pool.length);
    components.set(root, group);
  }

  // 寄送順序推測（Portaly 共寄出 N 封；舊程式依建立時間由舊到新寄送）——只當參考。
  const presumedCount = sends.length;
  const presumption = (subscriber: Subscriber) =>
    audience.indexOf(subscriber) < presumedCount ? '依寄送順序推測：可能已收到' : '依寄送順序推測：可能未收到';

  const resendable: Classified[] = [];
  const unknown: Classified[] = [];
  let outsiderSends = 0;
  for (const { persons, sends: sendIdx } of components.values()) {
    const people = persons.map((i) => pool[i]!);
    if (people.length === 0) {
      outsiderSends += sendIdx.length;
      continue;
    }
    if (sendIdx.length === 0) {
      for (const p of people) resendable.push({ email: p.email, subscriberId: p.id, reason: 'Portaly 沒有任何一封這期信件的遮罩地址對得上他' });
      continue;
    }
    const allDelivered = sendIdx.every((j) => remaining[j]!.recipients[0]?.status === 'delivered');
    const exact =
      people.length === sendIdx.length &&
      allDelivered &&
      perfectMatch(people.map((p) => p.email), sendIdx.map((j) => sendMasks[j]!)) !== null;
    if (exact) {
      for (const p of people) received.set(p.email.toLowerCase(), { email: p.email, subscriberId: p.id, reason: `Portaly delivered（同組遮罩 ${people.length} 人＝${sendIdx.length} 封）` });
      continue;
    }
    const why = !allDelivered
      ? `同組遮罩有未送達的信（${sendIdx.length} 封／${people.length} 人）`
      : `同組遮罩 ${people.length} 人只對到 ${sendIdx.length} 封，無法判斷是哪幾位`;
    for (const p of people) unknown.push({ email: p.email, subscriberId: p.id, reason: why, presumption: presumption(p) });
  }
  for (const subscriber of audience) {
    const reason = unknownReasons.get(subscriber.email.toLowerCase());
    if (reason) unknown.push({ email: subscriber.email, subscriberId: subscriber.id, reason, presumption: presumption(subscriber) });
  }
  if (outsiderSends > 0) {
    caveats.push(`${outsiderSends} 封 Portaly 信件對不到備份名單中的任何人（可能是備份之後才加入的訂閱者）`);
  }
  // 第二層推定：逐批、位置完全對齊（不允許位移）
  const batchesInOrder = batchOrder.map((batchId) => sends.filter((e) => (e.batchId ?? `single:${e.id}`) === batchId));
  let position = 0;
  let firstMismatchBatch: number | undefined;
  for (const [index, items] of batchesInOrder.entries()) {
    const window = audience.slice(position, position + items.length).map((p) => p.email);
    const masks = items.map((e) => parseMask(e.recipients[0]?.email ?? ''));
    if (window.length !== items.length || !perfectMatch(window, masks)) {
      firstMismatchBatch = index + 1;
      break;
    }
    position += items.length;
  }
  const orderVerified = firstMismatchBatch === undefined && batchesInOrder.length > 0;
  const officialResendable = new Set(resendable.map((r) => r.email.toLowerCase()));
  const presumedResendable: Classified[] = orderVerified
    ? audience
        .slice(position)
        .filter((p) => !officialResendable.has(p.email.toLowerCase()))
        .map((p) => ({ email: p.email, subscriberId: p.id, reason: '推定：位於最後一批之後（依寄送順序），需人工核准', presumption: '可能未收到' }))
    : [];
  if (!orderVerified) {
    caveats.push(
      firstMismatchBatch
        ? `寄送順序推定失敗：第 ${firstMismatchBatch} 批與重建名單對不齊，不提供推定名單`
        : '沒有可比對的批次，不提供推定名單',
    );
  }

  caveats.push(
    '備份之後到寄送當下之間的名單異動（新訂閱、退訂）不在備份內；新加入者不在可補寄名單，退訂者需另外排除。',
    '資料遺失期間按退訂的人可能沒有被記錄，需另外確認。',
  );

  return {
    method,
    portaly: portalySummary,
    audience: { size: audience.length },
    received: [...received.values()],
    resendable,
    unknown,
    excluded,
    unmatchedPortalySends: outsiderSends,
    orderCheck: { verified: orderVerified, firstMismatchBatch, presumedResendable },
    caveats,
  };
}

// ── CLI ─────────────────────────────────────────────────

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function required(name: string): string {
  const value = arg(name);
  if (!value) throw new Error(`需要 --${name}`);
  return value;
}

function toCsv(rows: Classified[]): string {
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return ['email,subscriber_id,reason,provider_message_id,presumption', ...rows.map((r) => [r.email, r.subscriberId, r.reason, r.providerMessageId, r.presumption].map(esc).join(','))].join('\n') + '\n';
}

async function main(): Promise<void> {
  const portalyPath = arg('portaly');
  const out = arg('out') ?? './reconcile-out';
  if (!portalyPath) throw new Error('需要 --portaly <Portaly 寄送紀錄 JSON>');
  const portalyRaw = JSON.parse(readFileSync(portalyPath, 'utf8')) as { items?: PortalyEmail[] } | PortalyEmail[];
  const portaly = Array.isArray(portalyRaw) ? portalyRaw : portalyRaw.items ?? [];
  const baselinePath = arg('baseline');
  const result = await reconcile({
    portaly,
    baseline: baselinePath ? loadBaseline(baselinePath) : undefined,
    campaignId: required('campaign'),
    subjectPrefix: required('subject'),
  });
  mkdirSync(out, { recursive: true });
  chmodSync(out, 0o700);
  const summary = {
    method: result.method,
    portaly: result.portaly,
    audience: result.audience,
    counts: {
      received: result.received.length,
      resendable: result.resendable.length,
      unknown: result.unknown.length,
      excluded: result.excluded.length,
    },
    unmatchedPortalySends: result.unmatchedPortalySends,
    orderCheck: {
      verified: result.orderCheck.verified,
      firstMismatchBatch: result.orderCheck.firstMismatchBatch,
      presumedResendable: result.orderCheck.presumedResendable.length,
    },
    caveats: result.caveats,
  };
  writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  writeFileSync(join(out, 'received-do-not-resend.csv'), toCsv(result.received));
  writeFileSync(join(out, 'resendable.csv'), toCsv(result.resendable));
  writeFileSync(join(out, 'unknown-do-not-resend.csv'), toCsv(result.unknown));
  writeFileSync(join(out, 'excluded.csv'), toCsv(result.excluded));
  writeFileSync(join(out, 'presumed-resendable-needs-approval.csv'), toCsv(result.orderCheck.presumedResendable));
  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1]?.endsWith('reconcile-resend.ts')) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

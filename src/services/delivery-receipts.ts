import { nowIso } from '../core/ids.js';
import type { Delivery, DeliveryReceipt } from '../store/types.js';
import type { ServiceContext } from './context.js';

/**
 * 後台看到的寄送狀態：寄送流程（status）加上服務商回報（receipt）。
 * - unknown：已交給服務商、結果不明（status=sending），要先對帳，不會自動重寄。
 * - accepted：服務商已收下，還沒收到送達或退信回報。
 * - delivered／bounced／complained：服務商的回報。
 * - failed：沒寄出（服務商拒收，或收下後回報沒寄出）。
 * 開信、點擊不算送達證據，這裡完全不看追蹤事件。
 */
export type DeliveryState =
  | 'pending'
  | 'skipped'
  | 'unknown'
  | 'accepted'
  | 'delivered'
  | 'bounced'
  | 'complained'
  | 'failed';

export const DELIVERY_STATES: readonly DeliveryState[] = [
  'pending',
  'skipped',
  'unknown',
  'accepted',
  'delivered',
  'bounced',
  'complained',
  'failed',
];

export function deliveryState(delivery: Pick<Delivery, 'status' | 'receipt'>): DeliveryState {
  if (delivery.status === 'pending') return 'pending';
  if (delivery.status === 'skipped') return 'skipped';
  if (delivery.status === 'sending') return 'unknown';
  const receipt = delivery.receipt ?? undefined;
  if (delivery.status === 'failed') {
    // 沒寄成的紀錄只認「沒送達」類的回報；舊資料或服務商直接拒收的就是 failed。
    return receipt === 'bounced' || receipt === 'complained' ? receipt : 'failed';
  }
  return receipt ?? 'accepted';
}

export type ReceiptStats = Record<DeliveryState, number> & { total: number };

/** 一份電子報各寄送狀態的筆數（服務商已收下／已送達／退信／檢舉／結果不明…）。 */
export async function campaignReceiptStats(ctx: ServiceContext, campaignId: string): Promise<ReceiptStats> {
  const stats = Object.fromEntries(DELIVERY_STATES.map((state) => [state, 0])) as ReceiptStats;
  stats.total = 0;
  for (const delivery of await ctx.store.listDeliveries(campaignId, { limit: 1_000_000 })) {
    stats[deliveryState(delivery)] += 1;
    stats.total += 1;
  }
  return stats;
}

/** 服務商回報的收件人狀態字串 → receipt。認不得的狀態只代表「服務商收下了」。 */
export function receiptFromProviderStatus(status: string | undefined): DeliveryReceipt {
  switch ((status ?? '').toLowerCase()) {
    case 'delivered':
      return 'delivered';
    case 'bounced':
    case 'bounce':
      return 'bounced';
    case 'complained':
    case 'complaint':
      return 'complained';
    case 'suppressed':
    case 'failed':
    case 'rejected':
    case 'dropped':
    case 'quota_exceeded':
    case 'domain_limited':
      return 'failed';
    default:
      return 'accepted';
  }
}

/** 回報的強弱：較弱的回報不會蓋掉較強的（例如晚到的「已送達」不會蓋掉「被檢舉」）。 */
const RANK: Record<DeliveryReceipt, number> = {
  accepted: 0,
  delivered: 1,
  failed: 2,
  bounced: 2,
  complained: 3,
};

/** 這份新回報要不要寫進去；要的話回傳 patch。 */
export function receiptPatch(
  delivery: Pick<Delivery, 'receipt'>,
  next: DeliveryReceipt,
  at: string = nowIso(),
): Pick<Delivery, 'receipt' | 'receiptAt'> | null {
  const current = delivery.receipt ?? undefined;
  if (current === next) return null;
  if (current && RANK[next] < RANK[current]) return null;
  return { receipt: next, receiptAt: at };
}

/**
 * 供應商 webhook／回查帶來的回報：用服務商訊息 id 找到寄送紀錄，記下 receipt。
 * 只記回報，不改 status（退信改 failed 等規則由 suppression 的共用處理負責）。
 */
export async function recordProviderReceipt(
  ctx: ServiceContext,
  providerMessageId: string | undefined,
  receipt: DeliveryReceipt,
): Promise<boolean> {
  if (!providerMessageId) return false;
  const delivery = await ctx.store.findDeliveryByProviderMessageId(providerMessageId);
  if (!delivery) return false;
  const patch = receiptPatch(delivery, receipt);
  if (!patch) return false;
  await ctx.store.updateDelivery(delivery.id, patch);
  return true;
}

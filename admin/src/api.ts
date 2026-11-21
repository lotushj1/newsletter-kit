import { IMAGE_TOO_LARGE_MESSAGE, MAX_UPLOAD_JSON_BYTES } from '../../src/core/upload-limits.js';
import { fileToBase64, jsonBodyBytes, prepareImageForUpload } from './prepare-image.js';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const response = await fetch(`/api/admin${path}`, {
    ...options,
    headers,
    credentials: 'same-origin',
  });
  if (response.status === 401) {
    window.location.href = `/admin/login?next=${encodeURIComponent(window.location.pathname)}`;
    throw new ApiError(401, '需要登入');
  }
  const text = await response.text();
  let data: T & { error?: string };
  try {
    data = text ? (JSON.parse(text) as T & { error?: string }) : ({} as T);
  } catch {
    if (response.status === 413) throw new ApiError(413, IMAGE_TOO_LARGE_MESSAGE);
    throw new ApiError(response.status, '請求失敗');
  }
  if (!response.ok) {
    const fallback = response.status === 413 ? IMAGE_TOO_LARGE_MESSAGE : '請求失敗';
    throw new ApiError(response.status, (data as { error?: string }).error ?? fallback);
  }
  return data;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  uploadImage: async (file: File) => {
    const prepared = await prepareImageForUpload(file);
    const fileBase64 = await fileToBase64(prepared);
    if (jsonBodyBytes(prepared.name, fileBase64) > MAX_UPLOAD_JSON_BYTES) {
      throw new ApiError(400, IMAGE_TOO_LARGE_MESSAGE);
    }
    return request<{ url: string; fileName: string; mime: string }>('/uploads', {
      method: 'POST',
      body: JSON.stringify({ fileName: prepared.name, fileBase64 }),
    });
  },
};

export interface CampaignStats {
  total: number;
  sent: number;
  failed: number;
  /** 已交給寄信服務、結果尚未確認的筆數（不會自動重寄）。 */
  unconfirmed?: number;
}

export interface TrackingStats {
  opens: number;
  uniqueOpens: number;
  clicks: number;
  uniqueClicks: number;
  unsubscribes: number;
  orphanEvents?: number;
}

export interface OverviewRates {
  newSubscribers: number;
  unsubscribes: number;
  sentCampaigns: number;
  sent: number;
  uniqueOpens: number;
  uniqueClicks: number;
  openRate: number | null;
  clickRate: number | null;
  orphanEvents?: number;
  dataIncomplete?: boolean;
}

export interface Campaign {
  id: string;
  title: string;
  slug: string;
  subject: string;
  preheader?: string;
  bodyMarkdown: string;
  bodyHtml: string;
  status: string;
  audienceTags: string[];
  audienceCondition?: import('../../src/store/types').AudienceCondition;
  audienceFolderId?: string;
  folderId?: string;
  scheduledAt?: string | null;
  sentAt?: string | null;
  /** 因單次寄送時間用完而暫停（排程 15 分鐘內會自動接續，也可手動續寄）。 */
  sendPausedAt?: string | null;
  sendPauseReason?: 'time_budget' | null;
  stats: CampaignStats;
  tracking: TrackingStats;
  createdAt: string;
  updatedAt: string;
}

export interface Subscriber {
  id: string;
  email: string;
  name?: string;
  status: string;
  tags: string[];
  folderId?: string;
  source?: string;
  createdAt: string;
}

export interface ContentTemplate {
  id: string;
  name: string;
  html: string;
  createdAt: string;
  updatedAt: string;
}

export type {
  BrandProfile,
  SignatureLayoutId,
  SignatureLink,
  SignatureLinkIcon,
} from '../../src/store/types';
export { EMPTY_BRAND } from '../../src/store/types';

export interface CampaignTemplate {
  id: string;
  name: string;
  description: string;
  title: string;
  preheader: string;
  bodyHtml: string;
  builtin: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface Folder {
  id: string;
  name: string;
  kind?: 'subscribers' | 'campaigns';
  createdAt: string;
  count?: number;
}

export interface SequenceStep {
  id: string;
  sequenceId: string;
  position: number;
  delayDays: number;
  campaignId: string;
}

export interface Sequence {
  id: string;
  name: string;
  trigger: 'subscribe' | 'tag' | 'event' | 'folder' | 'unsubscribe' | 'open' | 'click';
  triggerValue?: string;
  enabled: boolean;
  steps: SequenceStep[];
  stats?: { active: number; completed: number; canceled: number };
  createdAt: string;
  updatedAt: string;
}

export interface Session {
  siteName: string;
  provider: string;
  storeDriver: string;
  publicBaseUrl: string;
  from: string;
  replyTo: string | null;
  doubleOptIn: boolean;
  trackingEnabled: boolean;
  joinUrl: string;
  archiveUrl: string;
  mcpUrl: string;
  adminApiUrl: string;
  corsOrigins: string[];
  schedulerEnabled: boolean;
  batchSize: number;
  warnings: string[];
  availableProviders: string[];
  ai: {
    configured: boolean;
    provider: string;
    label: string;
    model: string | null;
    writes: boolean;
  };
}

export const STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  scheduled: '已排程',
  sending: '寄送中',
  sent: '已寄出',
  failed: '失敗',
  canceled: '已取消',
  pending: '待確認',
  subscribed: '已訂閱',
  unsubscribed: '已退訂',
  bounced: '退信',
};

/** 寄送紀錄的服務商回報狀態（見 src/services/delivery-receipts.ts）。開信點擊不算送達。 */
export const DELIVERY_STATE_LABEL: Record<string, string> = {
  pending: '待寄',
  skipped: '略過',
  unknown: '結果不明',
  accepted: '已交給寄信服務',
  delivered: '已送達',
  bounced: '退信',
  complained: '被檢舉為垃圾信',
  failed: '沒寄出',
};

export type ReceiptStats = Record<string, number> & { total: number };

export interface DeliveryReconcileInfo {
  at: string;
  by: string;
  result: 'confirmed' | 'not_found' | 'unsupported' | 'lookup_failed';
  note: string;
}

export const RECONCILE_RESULT_LABEL: Record<DeliveryReconcileInfo['result'], string> = {
  confirmed: '已查到',
  not_found: '查不到',
  unsupported: '服務商不支援查詢',
  lookup_failed: '查詢失敗',
};

export interface ReconcileQueueItem {
  id: string;
  campaignId: string;
  campaignTitle: string;
  campaignStatus: string;
  email: string;
  claimedAt?: string;
  attempts: number;
  error?: string;
  providerMessageId?: string;
  lookupRef: string;
  reconcile?: DeliveryReconcileInfo;
}

export interface ReconcileQueue {
  total: number;
  earliestAt: string | null;
  lookup: { provider: string; supported: boolean };
  items: ReconcileQueueItem[];
}

export interface ReconcileSummary {
  checked: number;
  confirmed: number;
  undelivered: number;
  stillUnknown: number;
  supported: boolean;
  reason: string;
  lookupError?: string;
}

/** POST /campaigns/:id/audience-count：按下寄送會寄給幾個人。 */
export interface RecipientPreview {
  /** audience＝依受眾條件；resend＝之前寄過，只補寄失敗與還沒寄出的。 */
  mode: 'audience' | 'resend';
  /** 實際會寄出的人數（已扣掉排除名單）。 */
  count: number;
  /** 符合條件、但因退訂、退信或排除名單不寄的人數。 */
  excluded: number;
}

export type { ReadinessAlert, ReadinessReport } from '../../src/services/readiness-types';

export function formatTime(iso?: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('zh-TW', { hour12: false });
}

export function formatRate(rate: number | null | undefined, sent = 0): string {
  if (rate == null || sent <= 0) return '—';
  const percent = rate * 100;
  return `${percent >= 10 ? percent.toFixed(0) : percent.toFixed(1)}%`;
}

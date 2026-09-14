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
  const data = text ? (JSON.parse(text) as T & { error?: string }) : ({} as T);
  if (!response.ok) {
    throw new ApiError(response.status, (data as { error?: string }).error ?? '請求失敗');
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
    if (file.size > 5 * 1024 * 1024) throw new ApiError(400, '圖片請小於 5 MB');
    return request<{ url: string; fileName: string; mime: string }>('/uploads', {
      method: 'POST',
      body: JSON.stringify({ fileName: file.name, fileBase64: await fileToBase64(file) }),
    });
  },
};

async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

export interface CampaignStats {
  total: number;
  sent: number;
  failed: number;
}

export interface TrackingStats {
  opens: number;
  uniqueOpens: number;
  clicks: number;
  uniqueClicks: number;
  unsubscribes: number;
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
  audienceFolderId?: string;
  folderId?: string;
  scheduledAt?: string | null;
  sentAt?: string | null;
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

export interface BrandProfile {
  writerName: string;
  websiteUrl: string;
  signatureHtml: string;
}

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
  corsOrigins: string[];
  schedulerEnabled: boolean;
  batchSize: number;
  warnings: string[];
  availableProviders: string[];
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

export function formatTime(iso?: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('zh-TW', { hour12: false });
}

export function formatRate(rate: number | null | undefined, sent = 0): string {
  if (rate == null || sent <= 0) return '—';
  const percent = rate * 100;
  return `${percent >= 10 ? percent.toFixed(0) : percent.toFixed(1)}%`;
}

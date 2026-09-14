export type SubscriberStatus = 'pending' | 'subscribed' | 'unsubscribed' | 'bounced';

export type FolderKind = 'subscribers' | 'campaigns';

export interface Folder {
  id: string;
  name: string;
  kind: FolderKind;
  createdAt: string;
}

export interface Subscriber {
  id: string;
  email: string;
  name?: string | undefined;
  status: SubscriberStatus;
  tags: string[];
  /** 分類資料夾；空值＝未分類 */
  folderId?: string | undefined;
  source?: string | undefined;
  createdAt: string;
  confirmedAt?: string | undefined;
  unsubscribedAt?: string | undefined;
  meta?: Record<string, unknown> | undefined;
}

export type CampaignStatus = 'draft' | 'scheduled' | 'sending' | 'sent' | 'failed' | 'canceled';

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

export interface Campaign {
  id: string;
  title: string;
  slug: string;
  subject: string;
  preheader?: string | undefined;
  /** 舊資料可能只有 Markdown；寄送時若 bodyHtml 空白會自動轉一次。 */
  bodyMarkdown: string;
  /** Tiptap 寫入的 HTML，正式內文。 */
  bodyHtml: string;
  status: CampaignStatus;
  /** 空陣列 = 不依標籤篩選；有值 = 只寄給帶到任一標籤的人 */
  audienceTags: string[];
  /** 空值 = 全部訂閱者；有值 = 只寄該資料夾 */
  audienceFolderId?: string | undefined;
  /** 電子報分類資料夾；空值＝未分類。跟寄送對象的 audienceFolderId 無關。 */
  folderId?: string | undefined;
  scheduledAt?: string | null | undefined;
  sentAt?: string | null | undefined;
  stats: CampaignStats;
  tracking: TrackingStats;
  createdAt: string;
  updatedAt: string;
}

export type DeliveryStatus = 'pending' | 'sent' | 'failed' | 'skipped';

export interface Delivery {
  id: string;
  campaignId: string;
  subscriberId: string;
  email: string;
  status: DeliveryStatus;
  attempts: number;
  error?: string | undefined;
  providerMessageId?: string | undefined;
  sentAt?: string | undefined;
}

export type TrackingEventType = 'open' | 'click' | 'unsubscribe';

export interface PeriodQuery {
  from?: string | undefined;
  to?: string | undefined;
}

export interface PeriodStats {
  newSubscribers: number;
  unsubscribes: number;
  sentCampaigns: number;
  sent: number;
  uniqueOpens: number;
  uniqueClicks: number;
}

export interface TrackingEvent {
  id: string;
  campaignId: string;
  subscriberId?: string | undefined;
  deliveryId?: string | undefined;
  type: TrackingEventType;
  url?: string | undefined;
  createdAt: string;
}

export type SequenceTrigger = 'subscribe' | 'tag' | 'event' | 'folder' | 'unsubscribe' | 'open' | 'click';
export type SequenceEnrollmentStatus = 'active' | 'completed' | 'canceled';

export interface Sequence {
  id: string;
  name: string;
  trigger: SequenceTrigger;
  /** tag 名稱或外部事件名稱；trigger=subscribe 時可空 */
  triggerValue?: string | undefined;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SequenceStep {
  id: string;
  sequenceId: string;
  position: number;
  delayDays: number;
  campaignId: string;
}

export interface ContentTemplate {
  id: string;
  /** 可用 `/` 分組，例如 Email/Welcome */
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

export const EMPTY_BRAND: BrandProfile = {
  writerName: '',
  websiteUrl: '',
  signatureHtml: '',
};

/** 使用者自訂的電子報建立模板（內建模板不進這張表）。 */
export interface CampaignStarter {
  id: string;
  name: string;
  description: string;
  title: string;
  preheader: string;
  bodyHtml: string;
  createdAt: string;
  updatedAt: string;
}

export interface SequenceEnrollment {
  id: string;
  sequenceId: string;
  subscriberId: string;
  stepIndex: number;
  nextRunAt: string;
  status: SequenceEnrollmentStatus;
  createdAt: string;
}

export interface Paged<T> {
  items: T[];
  total: number;
}

export interface SubscriberQuery {
  status?: SubscriberStatus | undefined;
  tag?: string | undefined;
  /** 指定資料夾 id；`unfiled` = 未分類 */
  folderId?: string | undefined;
  search?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface AudienceQuery {
  tags?: string[] | undefined;
  folderId?: string | undefined;
}

export interface CampaignQuery {
  status?: CampaignStatus | undefined;
  search?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  /** 指定電子報資料夾 id；`unfiled` = 未分類 */
  folderId?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

/**
 * 換資料庫只要實作這個介面（Postgres、MySQL、Airtable、你家的 BaaS 都行），
 * 再在 store/index.ts 或啟動程式裡注入即可，服務層不需要改。
 */
export interface Store {
  readonly driver: string;
  init(): Promise<void>;
  close(): Promise<void>;

  createSubscriber(subscriber: Subscriber): Promise<Subscriber>;
  updateSubscriber(id: string, patch: Partial<Subscriber>): Promise<Subscriber | null>;
  getSubscriber(id: string): Promise<Subscriber | null>;
  getSubscriberByEmail(email: string): Promise<Subscriber | null>;
  listSubscribers(query?: SubscriberQuery): Promise<Paged<Subscriber>>;
  listSubscriberTags(): Promise<string[]>;
  deleteSubscriber(id: string): Promise<boolean>;
  countSubscribersByStatus(): Promise<Record<SubscriberStatus, number>>;
  /** key 為 folderId，空字串代表未分類 */
  countSubscribersByFolder(): Promise<Record<string, number>>;
  /** 寄送對象：已訂閱，可再依資料夾與標籤縮小 */
  listAudience(query?: AudienceQuery): Promise<Subscriber[]>;

  createFolder(folder: Folder): Promise<Folder>;
  updateFolder(id: string, patch: Partial<Folder>): Promise<Folder | null>;
  getFolder(id: string): Promise<Folder | null>;
  listFolders(kind?: FolderKind): Promise<Folder[]>;
  deleteFolder(id: string): Promise<boolean>;
  /** key 為 folderId，空字串代表未分類 */
  countCampaignsByFolder(): Promise<Record<string, number>>;

  createCampaign(campaign: Campaign): Promise<Campaign>;
  updateCampaign(id: string, patch: Partial<Campaign>): Promise<Campaign | null>;
  getCampaign(id: string): Promise<Campaign | null>;
  getCampaignBySlug(slug: string): Promise<Campaign | null>;
  listCampaigns(query?: CampaignQuery): Promise<Paged<Campaign>>;
  deleteCampaign(id: string): Promise<boolean>;
  /** status=scheduled 且 scheduledAt <= nowIso */
  findDueCampaigns(nowIso: string): Promise<Campaign[]>;
  /** 重啟後要接續處理的 campaign（status=sending） */
  findSendingCampaigns(): Promise<Campaign[]>;

  createDeliveries(deliveries: Delivery[]): Promise<void>;
  updateDelivery(id: string, patch: Partial<Delivery>): Promise<void>;
  listDeliveries(
    campaignId: string,
    options?: { status?: DeliveryStatus | undefined; limit?: number | undefined },
  ): Promise<Delivery[]>;
  deliveryStats(campaignId: string): Promise<CampaignStats>;
  deleteDeliveries(campaignId: string): Promise<void>;

  createEvent(event: TrackingEvent): Promise<void>;
  campaignTrackingStats(campaignId: string): Promise<TrackingStats>;
  periodStats(query?: PeriodQuery): Promise<PeriodStats>;

  createSequence(sequence: Sequence): Promise<Sequence>;
  updateSequence(id: string, patch: Partial<Sequence>): Promise<Sequence | null>;
  getSequence(id: string): Promise<Sequence | null>;
  listSequences(): Promise<Sequence[]>;
  deleteSequence(id: string): Promise<boolean>;
  replaceSequenceSteps(sequenceId: string, steps: SequenceStep[]): Promise<SequenceStep[]>;
  listSequenceSteps(sequenceId: string): Promise<SequenceStep[]>;
  createEnrollment(enrollment: SequenceEnrollment): Promise<SequenceEnrollment>;
  updateEnrollment(id: string, patch: Partial<SequenceEnrollment>): Promise<SequenceEnrollment | null>;
  getEnrollment(sequenceId: string, subscriberId: string): Promise<SequenceEnrollment | null>;
  listEnrollments(sequenceId: string): Promise<SequenceEnrollment[]>;
  findDueEnrollments(nowIso: string): Promise<SequenceEnrollment[]>;

  createTemplate(template: ContentTemplate): Promise<ContentTemplate>;
  updateTemplate(id: string, patch: Partial<ContentTemplate>): Promise<ContentTemplate | null>;
  getTemplate(id: string): Promise<ContentTemplate | null>;
  listTemplates(): Promise<ContentTemplate[]>;
  deleteTemplate(id: string): Promise<boolean>;

  getSetting(key: string): Promise<string | undefined>;
  setSetting(key: string, value: string): Promise<void>;

  createCampaignStarter(starter: CampaignStarter): Promise<CampaignStarter>;
  updateCampaignStarter(id: string, patch: Partial<CampaignStarter>): Promise<CampaignStarter | null>;
  getCampaignStarter(id: string): Promise<CampaignStarter | null>;
  listCampaignStarters(): Promise<CampaignStarter[]>;
  deleteCampaignStarter(id: string): Promise<boolean>;
}

export const EMPTY_TRACKING: TrackingStats = {
  opens: 0,
  uniqueOpens: 0,
  clicks: 0,
  uniqueClicks: 0,
  unsubscribes: 0,
};

export function audienceFromCampaign(
  campaign: Pick<Campaign, 'audienceTags' | 'audienceFolderId'>,
): AudienceQuery {
  return {
    tags: campaign.audienceTags,
    folderId: campaign.audienceFolderId,
  };
}

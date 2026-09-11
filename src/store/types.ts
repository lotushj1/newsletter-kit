export type SubscriberStatus = 'pending' | 'subscribed' | 'unsubscribed' | 'bounced';

export interface Subscriber {
  id: string;
  email: string;
  name?: string | undefined;
  status: SubscriberStatus;
  tags: string[];
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

export interface Campaign {
  id: string;
  title: string;
  slug: string;
  subject: string;
  preheader?: string | undefined;
  bodyMarkdown: string;
  status: CampaignStatus;
  /** 空陣列 = 寄給所有已訂閱者；有值 = 只寄給帶到任一標籤的人 */
  audienceTags: string[];
  scheduledAt?: string | null | undefined;
  sentAt?: string | null | undefined;
  stats: CampaignStats;
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

export interface Paged<T> {
  items: T[];
  total: number;
}

export interface SubscriberQuery {
  status?: SubscriberStatus | undefined;
  tag?: string | undefined;
  search?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface CampaignQuery {
  status?: CampaignStatus | undefined;
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
  deleteSubscriber(id: string): Promise<boolean>;
  countSubscribersByStatus(): Promise<Record<SubscriberStatus, number>>;
  /** 寄送對象：status=subscribed，且 tags 命中任一（tags 為空代表全體） */
  listAudience(tags: string[]): Promise<Subscriber[]>;

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
}

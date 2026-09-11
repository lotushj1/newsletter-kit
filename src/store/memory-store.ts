import { conflict } from '../core/errors.js';
import type {
  Campaign,
  CampaignQuery,
  CampaignStats,
  Delivery,
  DeliveryStatus,
  Paged,
  Store,
  Subscriber,
  SubscriberQuery,
  SubscriberStatus,
} from './types.js';

const clone = <T>(value: T): T => structuredClone(value);

export interface MemorySnapshot {
  subscribers: Subscriber[];
  campaigns: Campaign[];
  deliveries: Delivery[];
}

/** 測試與 json driver 的共用底座。資料全在記憶體，不會自己持久化。 */
export class MemoryStore implements Store {
  readonly driver: string = 'memory';

  protected subscribers = new Map<string, Subscriber>();
  protected campaigns = new Map<string, Campaign>();
  protected deliveries = new Map<string, Delivery>();

  async init(): Promise<void> {}

  async close(): Promise<void> {}

  /** 子類別覆寫這個做持久化。 */
  protected async persist(): Promise<void> {}

  protected loadSnapshot(snapshot: MemorySnapshot): void {
    this.subscribers = new Map(snapshot.subscribers.map((s) => [s.id, s]));
    this.campaigns = new Map(snapshot.campaigns.map((c) => [c.id, c]));
    this.deliveries = new Map(snapshot.deliveries.map((d) => [d.id, d]));
  }

  protected snapshot(): MemorySnapshot {
    return {
      subscribers: [...this.subscribers.values()],
      campaigns: [...this.campaigns.values()],
      deliveries: [...this.deliveries.values()],
    };
  }

  // ── subscribers ─────────────────────────────────────────
  async createSubscriber(subscriber: Subscriber): Promise<Subscriber> {
    const existing = await this.getSubscriberByEmail(subscriber.email);
    if (existing) throw conflict('這個 Email 已在名單內');
    this.subscribers.set(subscriber.id, clone(subscriber));
    await this.persist();
    return clone(subscriber);
  }

  async updateSubscriber(id: string, patch: Partial<Subscriber>): Promise<Subscriber | null> {
    const current = this.subscribers.get(id);
    if (!current) return null;
    const next: Subscriber = { ...current, ...clone(patch), id: current.id };
    this.subscribers.set(id, next);
    await this.persist();
    return clone(next);
  }

  async getSubscriber(id: string): Promise<Subscriber | null> {
    const found = this.subscribers.get(id);
    return found ? clone(found) : null;
  }

  async getSubscriberByEmail(email: string): Promise<Subscriber | null> {
    const target = email.toLowerCase();
    for (const subscriber of this.subscribers.values()) {
      if (subscriber.email === target) return clone(subscriber);
    }
    return null;
  }

  async listSubscribers(query: SubscriberQuery = {}): Promise<Paged<Subscriber>> {
    const search = query.search?.toLowerCase();
    const filtered = [...this.subscribers.values()]
      .filter((s) => (query.status ? s.status === query.status : true))
      .filter((s) => (query.tag ? s.tags.includes(query.tag.toLowerCase()) : true))
      .filter((s) =>
        search
          ? s.email.includes(search) || (s.name ?? '').toLowerCase().includes(search)
          : true,
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 50;
    return { items: filtered.slice(offset, offset + limit).map(clone), total: filtered.length };
  }

  async deleteSubscriber(id: string): Promise<boolean> {
    const deleted = this.subscribers.delete(id);
    if (deleted) await this.persist();
    return deleted;
  }

  async countSubscribersByStatus(): Promise<Record<SubscriberStatus, number>> {
    const counts: Record<SubscriberStatus, number> = {
      pending: 0,
      subscribed: 0,
      unsubscribed: 0,
      bounced: 0,
    };
    for (const subscriber of this.subscribers.values()) counts[subscriber.status] += 1;
    return counts;
  }

  async listAudience(tags: string[]): Promise<Subscriber[]> {
    const wanted = tags.map((t) => t.toLowerCase());
    return [...this.subscribers.values()]
      .filter((s) => s.status === 'subscribed')
      .filter((s) => (wanted.length === 0 ? true : s.tags.some((t) => wanted.includes(t))))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(clone);
  }

  // ── campaigns ───────────────────────────────────────────
  /** stats 一律從 deliveries 現算，跟 sqlite driver 的行為保持一致。 */
  private withStats(campaign: Campaign): Campaign {
    const stats: CampaignStats = { total: 0, sent: 0, failed: 0 };
    for (const delivery of this.deliveries.values()) {
      if (delivery.campaignId !== campaign.id) continue;
      stats.total += 1;
      if (delivery.status === 'sent') stats.sent += 1;
      if (delivery.status === 'failed') stats.failed += 1;
    }
    return { ...clone(campaign), stats };
  }

  async createCampaign(campaign: Campaign): Promise<Campaign> {
    const existing = await this.getCampaignBySlug(campaign.slug);
    if (existing) throw conflict('這個 slug 已被使用');
    this.campaigns.set(campaign.id, clone(campaign));
    await this.persist();
    return this.withStats(campaign);
  }

  async updateCampaign(id: string, patch: Partial<Campaign>): Promise<Campaign | null> {
    const current = this.campaigns.get(id);
    if (!current) return null;
    if (patch.slug && patch.slug !== current.slug) {
      const clash = await this.getCampaignBySlug(patch.slug);
      if (clash && clash.id !== id) throw conflict('這個 slug 已被使用');
    }
    const next: Campaign = { ...current, ...clone(patch), id: current.id };
    this.campaigns.set(id, next);
    await this.persist();
    return this.withStats(next);
  }

  async getCampaign(id: string): Promise<Campaign | null> {
    const found = this.campaigns.get(id);
    return found ? this.withStats(found) : null;
  }

  async getCampaignBySlug(slug: string): Promise<Campaign | null> {
    for (const campaign of this.campaigns.values()) {
      if (campaign.slug === slug) return this.withStats(campaign);
    }
    return null;
  }

  async listCampaigns(query: CampaignQuery = {}): Promise<Paged<Campaign>> {
    const filtered = [...this.campaigns.values()]
      .filter((c) => (query.status ? c.status === query.status : true))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 50;
    return {
      items: filtered.slice(offset, offset + limit).map((c) => this.withStats(c)),
      total: filtered.length,
    };
  }

  async deleteCampaign(id: string): Promise<boolean> {
    const deleted = this.campaigns.delete(id);
    if (deleted) {
      await this.deleteDeliveries(id);
      await this.persist();
    }
    return deleted;
  }

  async findDueCampaigns(nowIso: string): Promise<Campaign[]> {
    return [...this.campaigns.values()]
      .filter((c) => c.status === 'scheduled' && !!c.scheduledAt && c.scheduledAt <= nowIso)
      .map((c) => this.withStats(c));
  }

  async findSendingCampaigns(): Promise<Campaign[]> {
    return [...this.campaigns.values()]
      .filter((c) => c.status === 'sending')
      .map((c) => this.withStats(c));
  }

  // ── deliveries ──────────────────────────────────────────
  async createDeliveries(deliveries: Delivery[]): Promise<void> {
    for (const delivery of deliveries) this.deliveries.set(delivery.id, clone(delivery));
    await this.persist();
  }

  async updateDelivery(id: string, patch: Partial<Delivery>): Promise<void> {
    const current = this.deliveries.get(id);
    if (!current) return;
    this.deliveries.set(id, { ...current, ...clone(patch), id: current.id });
    await this.persist();
  }

  async listDeliveries(
    campaignId: string,
    options: { status?: DeliveryStatus | undefined; limit?: number | undefined } = {},
  ): Promise<Delivery[]> {
    const items = [...this.deliveries.values()]
      .filter((d) => d.campaignId === campaignId)
      .filter((d) => (options.status ? d.status === options.status : true));
    return (options.limit ? items.slice(0, options.limit) : items).map(clone);
  }

  async deliveryStats(campaignId: string): Promise<CampaignStats> {
    const stats: CampaignStats = { total: 0, sent: 0, failed: 0 };
    for (const delivery of this.deliveries.values()) {
      if (delivery.campaignId !== campaignId) continue;
      stats.total += 1;
      if (delivery.status === 'sent') stats.sent += 1;
      if (delivery.status === 'failed') stats.failed += 1;
    }
    return stats;
  }

  async deleteDeliveries(campaignId: string): Promise<void> {
    for (const [id, delivery] of this.deliveries) {
      if (delivery.campaignId === campaignId) this.deliveries.delete(id);
    }
    await this.persist();
  }
}

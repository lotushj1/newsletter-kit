import { conflict } from '../core/errors.js';
import { campaignMatchesQuery } from './query.js';
import type {
  AudienceQuery,
  Campaign,
  CampaignQuery,
  CampaignStats,
  Delivery,
  DeliveryStatus,
  Folder,
  FolderKind,
  PeriodQuery,
  PeriodStats,
  Paged,
  CampaignStarter,
  ContentTemplate,
  Sequence,
  SequenceEnrollment,
  SequenceStep,
  Store,
  Subscriber,
  SubscriberQuery,
  SubscriberStatus,
  TrackingEvent,
  TrackingStats,
} from './types.js';
import { EMPTY_TRACKING } from './types.js';

const clone = <T>(value: T): T => structuredClone(value);

function matchesFolder(subscriber: Subscriber, folderId?: string): boolean {
  if (!folderId) return true;
  if (folderId === 'unfiled') return !subscriber.folderId;
  return subscriber.folderId === folderId;
}

export interface MemorySnapshot {
  subscribers: Subscriber[];
  campaigns: Campaign[];
  deliveries: Delivery[];
  events: TrackingEvent[];
  sequences: Sequence[];
  sequenceSteps: SequenceStep[];
  enrollments: SequenceEnrollment[];
  folders: Folder[];
  templates: ContentTemplate[];
  settings: Record<string, string>;
  campaignStarters: CampaignStarter[];
}

/** 測試與 json driver 的共用底座。資料全在記憶體，不會自己持久化。 */
export class MemoryStore implements Store {
  readonly driver: string = 'memory';

  protected subscribers = new Map<string, Subscriber>();
  protected campaigns = new Map<string, Campaign>();
  protected deliveries = new Map<string, Delivery>();
  protected events = new Map<string, TrackingEvent>();
  protected sequences = new Map<string, Sequence>();
  protected sequenceSteps = new Map<string, SequenceStep>();
  protected enrollments = new Map<string, SequenceEnrollment>();
  protected folders = new Map<string, Folder>();
  protected templates = new Map<string, ContentTemplate>();
  protected settings = new Map<string, string>();
  protected campaignStarters = new Map<string, CampaignStarter>();

  async init(): Promise<void> {}

  async close(): Promise<void> {}

  /** 子類別覆寫這個做持久化。 */
  protected async persist(): Promise<void> {}

  protected loadSnapshot(snapshot: MemorySnapshot): void {
    this.subscribers = new Map(snapshot.subscribers.map((s) => [s.id, s]));
    this.campaigns = new Map(
      snapshot.campaigns.map((c) => [
        c.id,
        { ...c, bodyHtml: c.bodyHtml ?? '', tracking: c.tracking ?? EMPTY_TRACKING },
      ]),
    );
    this.deliveries = new Map(snapshot.deliveries.map((d) => [d.id, d]));
    this.events = new Map((snapshot.events ?? []).map((e) => [e.id, e]));
    this.sequences = new Map((snapshot.sequences ?? []).map((s) => [s.id, s]));
    this.sequenceSteps = new Map((snapshot.sequenceSteps ?? []).map((s) => [s.id, s]));
    this.enrollments = new Map((snapshot.enrollments ?? []).map((e) => [e.id, e]));
    this.folders = new Map((snapshot.folders ?? []).map((f) => [f.id, f]));
    this.templates = new Map((snapshot.templates ?? []).map((t) => [t.id, t]));
    this.settings = new Map(Object.entries(snapshot.settings ?? {}));
    this.campaignStarters = new Map((snapshot.campaignStarters ?? []).map((t) => [t.id, t]));
  }

  protected snapshot(): MemorySnapshot {
    return {
      subscribers: [...this.subscribers.values()],
      campaigns: [...this.campaigns.values()],
      deliveries: [...this.deliveries.values()],
      events: [...this.events.values()],
      sequences: [...this.sequences.values()],
      sequenceSteps: [...this.sequenceSteps.values()],
      enrollments: [...this.enrollments.values()],
      folders: [...this.folders.values()],
      templates: [...this.templates.values()],
      settings: Object.fromEntries(this.settings),
      campaignStarters: [...this.campaignStarters.values()],
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
      .filter((s) => matchesFolder(s, query.folderId))
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

  async listSubscriberTags(): Promise<string[]> {
    const tags = new Set<string>();
    for (const subscriber of this.subscribers.values()) {
      for (const tag of subscriber.tags) tags.add(tag);
    }
    return [...tags].sort();
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

  async countSubscribersByFolder(): Promise<Record<string, number>> {
    const counts: Record<string, number> = { '': 0 };
    for (const subscriber of this.subscribers.values()) {
      const key = subscriber.folderId ?? '';
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }

  async listAudience(query: AudienceQuery = {}): Promise<Subscriber[]> {
    const wanted = (query.tags ?? []).map((t) => t.toLowerCase());
    return [...this.subscribers.values()]
      .filter((s) => s.status === 'subscribed')
      .filter((s) => matchesFolder(s, query.folderId))
      .filter((s) => (wanted.length === 0 ? true : s.tags.some((t) => wanted.includes(t))))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(clone);
  }

  async createFolder(folder: Folder): Promise<Folder> {
    const next = { ...folder, kind: folder.kind ?? 'subscribers' } as Folder;
    if (this.findFolderByName(next.name, undefined, next.kind)) throw conflict('這個資料夾名稱已被使用');
    this.folders.set(next.id, clone(next));
    await this.persist();
    return clone(next);
  }

  async updateFolder(id: string, patch: Partial<Folder>): Promise<Folder | null> {
    const current = this.folders.get(id);
    if (!current) return null;
    const kind = current.kind ?? 'subscribers';
    if (patch.name && this.findFolderByName(patch.name, id, kind)) throw conflict('這個資料夾名稱已被使用');
    const next: Folder = { ...current, ...clone(patch), id: current.id, kind };
    this.folders.set(id, next);
    await this.persist();
    return clone(next);
  }

  async getFolder(id: string): Promise<Folder | null> {
    const found = this.folders.get(id);
    return found ? clone({ ...found, kind: found.kind ?? 'subscribers' }) : null;
  }

  async listFolders(kind: FolderKind = 'subscribers'): Promise<Folder[]> {
    return [...this.folders.values()]
      .filter((folder) => (folder.kind ?? 'subscribers') === kind)
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'))
      .map((folder) => clone({ ...folder, kind: folder.kind ?? 'subscribers' }));
  }

  async deleteFolder(id: string): Promise<boolean> {
    const found = this.folders.get(id);
    if (!found) return false;
    if ((found.kind ?? 'subscribers') === 'campaigns') {
      for (const campaign of this.campaigns.values()) {
        if (campaign.folderId === id) {
          this.campaigns.set(campaign.id, { ...campaign, folderId: undefined });
        }
      }
    } else {
      for (const subscriber of this.subscribers.values()) {
        if (subscriber.folderId === id) {
          this.subscribers.set(subscriber.id, { ...subscriber, folderId: undefined });
        }
      }
      for (const campaign of this.campaigns.values()) {
        if (campaign.audienceFolderId === id) {
          this.campaigns.set(campaign.id, { ...campaign, audienceFolderId: undefined });
        }
      }
    }
    this.folders.delete(id);
    await this.persist();
    return true;
  }

  async countCampaignsByFolder(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const campaign of this.campaigns.values()) {
      const key = campaign.folderId ?? '';
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }

  private findFolderByName(name: string, exceptId?: string, kind: FolderKind = 'subscribers'): Folder | undefined {
    const target = name.trim().toLowerCase();
    return [...this.folders.values()].find(
      (folder) =>
        folder.name.toLowerCase() === target &&
        folder.id !== exceptId &&
        (folder.kind ?? 'subscribers') === kind,
    );
  }

  // ── campaigns ───────────────────────────────────────────
  private async hydrateCampaign(campaign: Campaign): Promise<Campaign> {
    return {
      ...clone(campaign),
      bodyHtml: campaign.bodyHtml ?? '',
      stats: await this.deliveryStats(campaign.id),
      tracking: await this.campaignTrackingStats(campaign.id),
    };
  }

  async createCampaign(campaign: Campaign): Promise<Campaign> {
    const existing = await this.getCampaignBySlug(campaign.slug);
    if (existing) throw conflict('這個 slug 已被使用');
    const stored: Campaign = {
      ...clone(campaign),
      bodyHtml: campaign.bodyHtml ?? '',
      tracking: campaign.tracking ?? EMPTY_TRACKING,
    };
    this.campaigns.set(campaign.id, stored);
    await this.persist();
    return this.hydrateCampaign(stored);
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
    return this.hydrateCampaign(next);
  }

  async getCampaign(id: string): Promise<Campaign | null> {
    const found = this.campaigns.get(id);
    return found ? this.hydrateCampaign(found) : null;
  }

  async getCampaignBySlug(slug: string): Promise<Campaign | null> {
    for (const campaign of this.campaigns.values()) {
      if (campaign.slug === slug) return this.hydrateCampaign(campaign);
    }
    return null;
  }

  async listCampaigns(query: CampaignQuery = {}): Promise<Paged<Campaign>> {
    const filtered = [...this.campaigns.values()]
      .filter((c) => campaignMatchesQuery(c, query))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 50;
    const items = await Promise.all(filtered.slice(offset, offset + limit).map((c) => this.hydrateCampaign(c)));
    return { items, total: filtered.length };
  }

  async deleteCampaign(id: string): Promise<boolean> {
    const deleted = this.campaigns.delete(id);
    if (deleted) {
      await this.deleteDeliveries(id);
      for (const [eventId, event] of this.events) {
        if (event.campaignId === id) this.events.delete(eventId);
      }
      await this.persist();
    }
    return deleted;
  }

  async findDueCampaigns(nowIso: string): Promise<Campaign[]> {
    return Promise.all(
      [...this.campaigns.values()]
        .filter((c) => c.status === 'scheduled' && !!c.scheduledAt && c.scheduledAt <= nowIso)
        .map((c) => this.hydrateCampaign(c)),
    );
  }

  async findSendingCampaigns(): Promise<Campaign[]> {
    return Promise.all(
      [...this.campaigns.values()].filter((c) => c.status === 'sending').map((c) => this.hydrateCampaign(c)),
    );
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

  // ── tracking ────────────────────────────────────────────
  async createEvent(event: TrackingEvent): Promise<void> {
    this.events.set(event.id, clone(event));
    await this.persist();
  }

  async campaignTrackingStats(campaignId: string): Promise<TrackingStats> {
    const opens = new Set<string>();
    const clicks = new Set<string>();
    let openCount = 0;
    let clickCount = 0;
    for (const event of this.events.values()) {
      if (event.campaignId !== campaignId) continue;
      const who = event.subscriberId ?? event.id;
      if (event.type === 'open') {
        openCount += 1;
        opens.add(who);
      }
      if (event.type === 'click') {
        clickCount += 1;
        clicks.add(who);
      }
    }
    const unsubscribed = new Set<string>();
    for (const event of this.events.values()) {
      if (event.campaignId !== campaignId || event.type !== 'unsubscribe') continue;
      unsubscribed.add(event.subscriberId ?? event.id);
    }
    for (const delivery of this.deliveries.values()) {
      if (delivery.campaignId !== campaignId || delivery.status !== 'sent') continue;
      const subscriber = this.subscribers.get(delivery.subscriberId);
      if (!subscriber?.unsubscribedAt) continue;
      if (delivery.sentAt && subscriber.unsubscribedAt < delivery.sentAt) continue;
      unsubscribed.add(subscriber.id);
    }
    return {
      opens: openCount,
      uniqueOpens: opens.size,
      clicks: clickCount,
      uniqueClicks: clicks.size,
      unsubscribes: unsubscribed.size,
    };
  }

  async periodStats(query: PeriodQuery = {}): Promise<PeriodStats> {
    const from = query.from;
    const to = query.to;
    const inRange = (value?: string) => {
      if (!value) return false;
      if (from && value < from) return false;
      if (to && value > to) return false;
      return true;
    };

    let newSubscribers = 0;
    let unsubscribes = 0;
    for (const subscriber of this.subscribers.values()) {
      const joined = subscriber.confirmedAt ?? subscriber.createdAt;
      if (subscriber.status !== 'pending' && inRange(joined)) newSubscribers += 1;
      if (inRange(subscriber.unsubscribedAt)) unsubscribes += 1;
    }

    const sentCampaigns = new Set<string>();
    let sent = 0;
    for (const delivery of this.deliveries.values()) {
      if (delivery.status !== 'sent' || !inRange(delivery.sentAt)) continue;
      sent += 1;
      sentCampaigns.add(delivery.campaignId);
    }

    const opens = new Set<string>();
    const clicks = new Set<string>();
    for (const event of this.events.values()) {
      if (!inRange(event.createdAt)) continue;
      const who = event.subscriberId ?? event.id;
      if (event.type === 'open') opens.add(who);
      if (event.type === 'click') clicks.add(who);
    }

    return {
      newSubscribers,
      unsubscribes,
      sentCampaigns: sentCampaigns.size,
      sent,
      uniqueOpens: opens.size,
      uniqueClicks: clicks.size,
    };
  }

  // ── sequences ───────────────────────────────────────────
  async createSequence(sequence: Sequence): Promise<Sequence> {
    this.sequences.set(sequence.id, clone(sequence));
    await this.persist();
    return clone(sequence);
  }

  async updateSequence(id: string, patch: Partial<Sequence>): Promise<Sequence | null> {
    const current = this.sequences.get(id);
    if (!current) return null;
    const next = { ...current, ...clone(patch), id };
    this.sequences.set(id, next);
    await this.persist();
    return clone(next);
  }

  async getSequence(id: string): Promise<Sequence | null> {
    const found = this.sequences.get(id);
    return found ? clone(found) : null;
  }

  async listSequences(): Promise<Sequence[]> {
    return [...this.sequences.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(clone);
  }

  async deleteSequence(id: string): Promise<boolean> {
    const deleted = this.sequences.delete(id);
    if (deleted) {
      for (const [stepId, step] of this.sequenceSteps) {
        if (step.sequenceId === id) this.sequenceSteps.delete(stepId);
      }
      for (const [enrollId, enrollment] of this.enrollments) {
        if (enrollment.sequenceId === id) this.enrollments.delete(enrollId);
      }
      await this.persist();
    }
    return deleted;
  }

  async replaceSequenceSteps(sequenceId: string, steps: SequenceStep[]): Promise<SequenceStep[]> {
    for (const [id, step] of this.sequenceSteps) {
      if (step.sequenceId === sequenceId) this.sequenceSteps.delete(id);
    }
    for (const step of steps) this.sequenceSteps.set(step.id, clone(step));
    await this.persist();
    return steps.map(clone);
  }

  async listSequenceSteps(sequenceId: string): Promise<SequenceStep[]> {
    return [...this.sequenceSteps.values()]
      .filter((s) => s.sequenceId === sequenceId)
      .sort((a, b) => a.position - b.position)
      .map(clone);
  }

  async createEnrollment(enrollment: SequenceEnrollment): Promise<SequenceEnrollment> {
    this.enrollments.set(enrollment.id, clone(enrollment));
    await this.persist();
    return clone(enrollment);
  }

  async updateEnrollment(
    id: string,
    patch: Partial<SequenceEnrollment>,
  ): Promise<SequenceEnrollment | null> {
    const current = this.enrollments.get(id);
    if (!current) return null;
    const next = { ...current, ...clone(patch), id };
    this.enrollments.set(id, next);
    await this.persist();
    return clone(next);
  }

  async getEnrollment(sequenceId: string, subscriberId: string): Promise<SequenceEnrollment | null> {
    for (const enrollment of this.enrollments.values()) {
      if (enrollment.sequenceId === sequenceId && enrollment.subscriberId === subscriberId) {
        return clone(enrollment);
      }
    }
    return null;
  }

  async listEnrollments(sequenceId: string): Promise<SequenceEnrollment[]> {
    return [...this.enrollments.values()]
      .filter((e) => e.sequenceId === sequenceId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(clone);
  }

  async findDueEnrollments(nowIso: string): Promise<SequenceEnrollment[]> {
    return [...this.enrollments.values()]
      .filter((e) => e.status === 'active' && e.nextRunAt <= nowIso)
      .map(clone);
  }

  async createTemplate(template: ContentTemplate): Promise<ContentTemplate> {
    if (this.findTemplateByName(template.name)) throw conflict('這個範本名稱已被使用');
    this.templates.set(template.id, clone(template));
    await this.persist();
    return clone(template);
  }

  async updateTemplate(id: string, patch: Partial<ContentTemplate>): Promise<ContentTemplate | null> {
    const current = this.templates.get(id);
    if (!current) return null;
    if (patch.name && this.findTemplateByName(patch.name, id)) throw conflict('這個範本名稱已被使用');
    const next: ContentTemplate = { ...current, ...clone(patch), id: current.id };
    this.templates.set(id, next);
    await this.persist();
    return clone(next);
  }

  async getTemplate(id: string): Promise<ContentTemplate | null> {
    const found = this.templates.get(id);
    return found ? clone(found) : null;
  }

  async listTemplates(): Promise<ContentTemplate[]> {
    return [...this.templates.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant')).map(clone);
  }

  async deleteTemplate(id: string): Promise<boolean> {
    const ok = this.templates.delete(id);
    if (ok) await this.persist();
    return ok;
  }

  private findTemplateByName(name: string, exceptId?: string): ContentTemplate | undefined {
    const target = name.trim().toLowerCase();
    return [...this.templates.values()].find((item) => item.name.toLowerCase() === target && item.id !== exceptId);
  }

  async getSetting(key: string): Promise<string | undefined> {
    return this.settings.get(key);
  }

  async setSetting(key: string, value: string): Promise<void> {
    this.settings.set(key, value);
    await this.persist();
  }

  async createCampaignStarter(starter: CampaignStarter): Promise<CampaignStarter> {
    if (this.findStarterByName(starter.name)) throw conflict('這個模板名稱已被使用');
    this.campaignStarters.set(starter.id, clone(starter));
    await this.persist();
    return clone(starter);
  }

  async updateCampaignStarter(
    id: string,
    patch: Partial<CampaignStarter>,
  ): Promise<CampaignStarter | null> {
    const current = this.campaignStarters.get(id);
    if (!current) return null;
    if (patch.name && this.findStarterByName(patch.name, id)) throw conflict('這個模板名稱已被使用');
    const next: CampaignStarter = { ...current, ...clone(patch), id: current.id };
    this.campaignStarters.set(id, next);
    await this.persist();
    return clone(next);
  }

  async getCampaignStarter(id: string): Promise<CampaignStarter | null> {
    const found = this.campaignStarters.get(id);
    return found ? clone(found) : null;
  }

  async listCampaignStarters(): Promise<CampaignStarter[]> {
    return [...this.campaignStarters.values()]
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'))
      .map(clone);
  }

  async deleteCampaignStarter(id: string): Promise<boolean> {
    const ok = this.campaignStarters.delete(id);
    if (ok) await this.persist();
    return ok;
  }

  private findStarterByName(name: string, exceptId?: string): CampaignStarter | undefined {
    const target = name.trim().toLowerCase();
    return [...this.campaignStarters.values()].find(
      (item) => item.name.toLowerCase() === target && item.id !== exceptId,
    );
  }
}

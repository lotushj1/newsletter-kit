import type { Campaign, CampaignQuery } from './types.js';

export function campaignWhen(campaign: Campaign): string {
  return campaign.sentAt || campaign.createdAt;
}

export function campaignMatchesQuery(campaign: Campaign, query: CampaignQuery): boolean {
  if (query.status && campaign.status !== query.status) return false;
  if (query.search) {
    const needle = query.search.toLowerCase();
    const hay = `${campaign.title} ${campaign.subject} ${campaign.slug}`.toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  const when = campaignWhen(campaign);
  if (query.from && when < query.from) return false;
  if (query.to && when > query.to) return false;
  if (query.folderId === 'unfiled') return !campaign.folderId;
  if (query.folderId) return campaign.folderId === query.folderId;
  return true;
}

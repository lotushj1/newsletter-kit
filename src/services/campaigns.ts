import { campaignContentHtml, campaignHasBody } from '../core/body.js';
import { badRequest, notFound } from '../core/errors.js';
import { newId, nowIso, slugify } from '../core/ids.js';
import { htmlToText, markdownToHtml, renderEmailLayout } from '../core/render.js';
import {
  normalizeTags,
  optionalString,
  parseIsoDate,
  requireString,
} from '../core/validate.js';
import type { Campaign, CampaignQuery, Paged, Subscriber } from '../store/types.js';
import { audienceFromCampaign, EMPTY_TRACKING } from '../store/types.js';
import type { ServiceContext } from './context.js';
import { resolveFolderId } from './folders.js';
import { PREVIEW_RECIPIENT } from '../core/preview-email.js';
import { applyCampaignVariables, getBrand, mergeBrandVariables } from './brand.js';
import { subscriberVariables, unsubscribeUrl } from './subscribers.js';

export interface CampaignInput {
  title?: unknown;
  slug?: unknown;
  subject?: unknown;
  preheader?: unknown;
  bodyMarkdown?: unknown;
  bodyHtml?: unknown;
  audienceTags?: unknown;
  audienceFolderId?: unknown;
  folderId?: unknown;
}

const EDITABLE_STATUSES: Campaign['status'][] = ['draft', 'scheduled', 'failed', 'canceled'];

function assertEditable(campaign: Campaign): void {
  if (!EDITABLE_STATUSES.includes(campaign.status)) {
    throw badRequest(`狀態為「${campaign.status}」的電子報不能再編輯`);
  }
}

function resolveBodies(input: CampaignInput, current?: Campaign): { bodyHtml: string; bodyMarkdown: string } {
  const markdown = typeof input.bodyMarkdown === 'string' ? input.bodyMarkdown : current?.bodyMarkdown ?? '';
  if (typeof input.bodyHtml === 'string') {
    return { bodyHtml: input.bodyHtml, bodyMarkdown: markdown };
  }
  if (typeof input.bodyMarkdown === 'string') {
    return { bodyHtml: markdownToHtml(input.bodyMarkdown), bodyMarkdown: input.bodyMarkdown };
  }
  return { bodyHtml: current?.bodyHtml ?? '', bodyMarkdown: current?.bodyMarkdown ?? '' };
}

async function allocateSlug(ctx: ServiceContext, desired: string): Promise<string> {
  const base = slugify(desired);
  if (!(await ctx.store.getCampaignBySlug(base))) return base;
  for (let index = 2; index < 50; index += 1) {
    const candidate = `${base}-${index}`;
    if (!(await ctx.store.getCampaignBySlug(candidate))) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

export async function createCampaign(
  ctx: ServiceContext,
  input: CampaignInput,
): Promise<Campaign> {
  const title = requireString(input.title, '標題', 200);
  const subject = optionalString(input.subject, '主旨', 200) ?? title;
  const timestamp = nowIso();
  const bodies = resolveBodies(input);
  const requestedSlug = optionalString(input.slug, 'slug', 200);
  const slug = requestedSlug ? slugify(requestedSlug) : await allocateSlug(ctx, title);
  return ctx.store.createCampaign({
    id: newId('cmp'),
    title,
    slug,
    subject,
    preheader: optionalString(input.preheader, '前導文字', 200),
    bodyMarkdown: bodies.bodyMarkdown,
    bodyHtml: bodies.bodyHtml,
    status: 'draft',
    audienceTags: normalizeTags(input.audienceTags),
    audienceFolderId: await resolveFolderId(ctx, input.audienceFolderId),
    folderId: await resolveFolderId(ctx, input.folderId, 'campaigns'),
    scheduledAt: null,
    sentAt: null,
    stats: { total: 0, sent: 0, failed: 0 },
    tracking: EMPTY_TRACKING,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

export async function getCampaign(ctx: ServiceContext, id: string): Promise<Campaign> {
  const campaign = await ctx.store.getCampaign(id);
  if (!campaign) throw notFound('找不到這份電子報');
  return campaign;
}

export function listCampaigns(
  ctx: ServiceContext,
  query: CampaignQuery,
): Promise<Paged<Campaign>> {
  return ctx.store.listCampaigns(query);
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

export async function overviewRates(
  ctx: ServiceContext,
  range?: { from?: string; to?: string },
): Promise<OverviewRates> {
  const stats = await ctx.store.periodStats(range);
  return {
    ...stats,
    openRate: stats.sent > 0 ? stats.uniqueOpens / stats.sent : null,
    clickRate: stats.sent > 0 ? stats.uniqueClicks / stats.sent : null,
  };
}

export async function updateCampaign(
  ctx: ServiceContext,
  id: string,
  input: CampaignInput,
): Promise<Campaign> {
  const campaign = await getCampaign(ctx, id);
  assertEditable(campaign);

  const patch: Partial<Campaign> = { updatedAt: nowIso() };
  if (input.title !== undefined) patch.title = requireString(input.title, '標題', 200);
  if (input.slug !== undefined) patch.slug = slugify(requireString(input.slug, 'slug', 200));
  if (input.subject !== undefined) patch.subject = requireString(input.subject, '主旨', 200);
  if (input.preheader !== undefined) {
    patch.preheader = optionalString(input.preheader, '前導文字', 200);
  }
  if (input.bodyMarkdown !== undefined || input.bodyHtml !== undefined) {
    if (input.bodyMarkdown !== undefined && typeof input.bodyMarkdown !== 'string') {
      throw badRequest('內文格式不正確');
    }
    if (input.bodyHtml !== undefined && typeof input.bodyHtml !== 'string') {
      throw badRequest('內文格式不正確');
    }
    const bodies = resolveBodies(input, campaign);
    patch.bodyHtml = bodies.bodyHtml;
    patch.bodyMarkdown = bodies.bodyMarkdown;
  }
  if (input.audienceTags !== undefined) patch.audienceTags = normalizeTags(input.audienceTags);
  if (input.audienceFolderId !== undefined) {
    patch.audienceFolderId = await resolveFolderId(ctx, input.audienceFolderId);
  }
  if (input.folderId !== undefined) {
    patch.folderId = await resolveFolderId(ctx, input.folderId, 'campaigns');
  }

  const updated = await ctx.store.updateCampaign(id, patch);
  if (!updated) throw notFound('找不到這份電子報');
  return updated;
}

export async function deleteCampaign(ctx: ServiceContext, id: string): Promise<void> {
  const campaign = await getCampaign(ctx, id);
  if (campaign.status === 'sending') throw badRequest('正在寄送中的電子報不能刪除');
  await ctx.store.deleteCampaign(id);
}

export async function setCampaignFolder(
  ctx: ServiceContext,
  id: string,
  folderId: unknown,
): Promise<Campaign> {
  await getCampaign(ctx, id);
  const updated = await ctx.store.updateCampaign(id, {
    folderId: await resolveFolderId(ctx, folderId, 'campaigns'),
    updatedAt: nowIso(),
  });
  if (!updated) throw notFound('找不到這份電子報');
  return updated;
}

export async function bulkSetCampaignFolder(
  ctx: ServiceContext,
  ids: string[],
  folderId: unknown,
): Promise<Campaign[]> {
  const items: Campaign[] = [];
  for (const id of ids) items.push(await setCampaignFolder(ctx, id, folderId));
  return items;
}

export async function bulkDeleteCampaigns(
  ctx: ServiceContext,
  ids: string[],
): Promise<{ deleted: number; failed: Array<{ id: string; error: string }> }> {
  const failed: Array<{ id: string; error: string }> = [];
  let deleted = 0;
  for (const id of ids) {
    try {
      await deleteCampaign(ctx, id);
      deleted += 1;
    } catch (error) {
      failed.push({ id, error: error instanceof Error ? error.message : '刪除失敗' });
    }
  }
  return { deleted, failed };
}

export async function scheduleCampaign(
  ctx: ServiceContext,
  id: string,
  scheduledAtRaw: unknown,
): Promise<Campaign> {
  const campaign = await getCampaign(ctx, id);
  assertEditable(campaign);
  if (!campaignHasBody(campaign)) throw badRequest('內文還是空的，先寫點東西再排程');

  const scheduledAt = parseIsoDate(scheduledAtRaw, '排程時間');
  if (new Date(scheduledAt).getTime() < Date.now() - 60_000) {
    throw badRequest('排程時間不能是過去');
  }
  const updated = await ctx.store.updateCampaign(id, {
    status: 'scheduled',
    scheduledAt,
    updatedAt: nowIso(),
  });
  return updated!;
}

export async function cancelSchedule(ctx: ServiceContext, id: string): Promise<Campaign> {
  const campaign = await getCampaign(ctx, id);
  if (campaign.status !== 'scheduled') throw badRequest('只有已排程的電子報可以取消排程');
  const updated = await ctx.store.updateCampaign(id, {
    status: 'draft',
    scheduledAt: null,
    updatedAt: nowIso(),
  });
  return updated!;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

async function campaignVariables(
  ctx: ServiceContext,
  recipient: Pick<Subscriber, 'email' | 'name'>,
): Promise<Record<string, string>> {
  return mergeBrandVariables(subscriberVariables(ctx, recipient), await getBrand(ctx));
}

/** 寄送與預覽共用的渲染流程：HTML（或舊 Markdown）→ 變數替換 → 套版型。 */
export async function renderCampaign(
  ctx: ServiceContext,
  campaign: Campaign,
  recipient: Pick<Subscriber, 'email' | 'name'>,
): Promise<RenderedEmail> {
  const variables = await campaignVariables(ctx, recipient);
  const contentHtml = applyCampaignVariables(campaignContentHtml(campaign), variables, 'html');
  const subject = applyCampaignVariables(campaign.subject, variables, 'text');
  const html = renderEmailLayout({
    subject,
    preheader: campaign.preheader
      ? applyCampaignVariables(campaign.preheader, variables, 'text')
      : undefined,
    contentHtml,
    siteName: ctx.config.siteName,
    publicBaseUrl: ctx.config.publicBaseUrl,
    unsubscribeUrl: unsubscribeUrl(ctx, recipient.email),
  });
  return { subject, html, text: htmlToText(html) };
}

export { PREVIEW_RECIPIENT };

export async function previewCampaign(
  ctx: ServiceContext,
  id: string,
  recipient: Pick<Subscriber, 'email' | 'name'> = PREVIEW_RECIPIENT,
): Promise<RenderedEmail & { audienceCount: number }> {
  const campaign = await getCampaign(ctx, id);
  const audience = await ctx.store.listAudience(audienceFromCampaign(campaign));
  return { ...(await renderCampaign(ctx, campaign, recipient)), audienceCount: audience.length };
}

/** 封存頁沒有特定收件人，個人化變數一律換成通用值。 */
function publicVariables(ctx: ServiceContext): Record<string, string> {
  return { name: '朋友', email: '', site_name: ctx.config.siteName, unsubscribe_url: '' };
}

export async function publicSubject(ctx: ServiceContext, campaign: Campaign): Promise<string> {
  const variables = mergeBrandVariables(publicVariables(ctx), await getBrand(ctx));
  return applyCampaignVariables(campaign.subject, variables, 'text');
}

/** 公開封存頁用：只吐已寄出的內容，且不帶個人化變數、不注入追蹤。 */
export async function renderPublicCampaign(
  ctx: ServiceContext,
  slug: string,
): Promise<{ campaign: Campaign; html: string; subject: string } | null> {
  const campaign = await ctx.store.getCampaignBySlug(slug);
  if (!campaign || campaign.status !== 'sent') return null;
  const variables = mergeBrandVariables(publicVariables(ctx), await getBrand(ctx));
  return {
    campaign,
    subject: applyCampaignVariables(campaign.subject, variables, 'text'),
    html: applyCampaignVariables(campaignContentHtml(campaign), variables, 'html'),
  };
}

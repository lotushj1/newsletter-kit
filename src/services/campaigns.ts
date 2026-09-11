import { badRequest, notFound } from '../core/errors.js';
import { newId, nowIso, slugify } from '../core/ids.js';
import {
  applyVariables,
  htmlToText,
  markdownToHtml,
  renderEmailLayout,
} from '../core/render.js';
import {
  normalizeTags,
  optionalString,
  parseIsoDate,
  requireString,
} from '../core/validate.js';
import type { Campaign, CampaignQuery, Paged, Subscriber } from '../store/types.js';
import type { ServiceContext } from './context.js';
import { subscriberVariables, unsubscribeUrl } from './subscribers.js';

export interface CampaignInput {
  title?: unknown;
  slug?: unknown;
  subject?: unknown;
  preheader?: unknown;
  bodyMarkdown?: unknown;
  audienceTags?: unknown;
}

const EDITABLE_STATUSES: Campaign['status'][] = ['draft', 'scheduled', 'failed', 'canceled'];

function assertEditable(campaign: Campaign): void {
  if (!EDITABLE_STATUSES.includes(campaign.status)) {
    throw badRequest(`狀態為「${campaign.status}」的電子報不能再編輯`);
  }
}

export async function createCampaign(
  ctx: ServiceContext,
  input: CampaignInput,
): Promise<Campaign> {
  const title = requireString(input.title, '標題', 200);
  const subject = optionalString(input.subject, '主旨', 200) ?? title;
  const timestamp = nowIso();
  return ctx.store.createCampaign({
    id: newId('cmp'),
    title,
    slug: slugify(optionalString(input.slug, 'slug', 200) ?? title),
    subject,
    preheader: optionalString(input.preheader, '前導文字', 200),
    bodyMarkdown: typeof input.bodyMarkdown === 'string' ? input.bodyMarkdown : '',
    status: 'draft',
    audienceTags: normalizeTags(input.audienceTags),
    scheduledAt: null,
    sentAt: null,
    stats: { total: 0, sent: 0, failed: 0 },
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
  if (input.bodyMarkdown !== undefined) {
    if (typeof input.bodyMarkdown !== 'string') throw badRequest('內文格式不正確');
    patch.bodyMarkdown = input.bodyMarkdown;
  }
  if (input.audienceTags !== undefined) patch.audienceTags = normalizeTags(input.audienceTags);

  const updated = await ctx.store.updateCampaign(id, patch);
  if (!updated) throw notFound('找不到這份電子報');
  return updated;
}

export async function deleteCampaign(ctx: ServiceContext, id: string): Promise<void> {
  const campaign = await getCampaign(ctx, id);
  if (campaign.status === 'sending') throw badRequest('正在寄送中的電子報不能刪除');
  await ctx.store.deleteCampaign(id);
}

export async function scheduleCampaign(
  ctx: ServiceContext,
  id: string,
  scheduledAtRaw: unknown,
): Promise<Campaign> {
  const campaign = await getCampaign(ctx, id);
  assertEditable(campaign);
  if (campaign.bodyMarkdown.trim() === '') throw badRequest('內文還是空的，先寫點東西再排程');

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

/** 寄送與預覽共用的渲染流程：markdown → HTML → 變數替換 → 套版型。 */
export function renderCampaign(
  ctx: ServiceContext,
  campaign: Campaign,
  recipient: Pick<Subscriber, 'email' | 'name'>,
): RenderedEmail {
  const variables = subscriberVariables(ctx, recipient);
  const contentHtml = applyVariables(markdownToHtml(campaign.bodyMarkdown), variables, 'html');
  const subject = applyVariables(campaign.subject, variables, 'text');
  const html = renderEmailLayout({
    subject,
    preheader: campaign.preheader
      ? applyVariables(campaign.preheader, variables, 'text')
      : undefined,
    contentHtml,
    siteName: ctx.config.siteName,
    unsubscribeUrl: unsubscribeUrl(ctx, recipient.email),
  });
  return { subject, html, text: htmlToText(html) };
}

/** 後台預覽用的假收件人，不會動到真實名單。 */
export const PREVIEW_RECIPIENT: Pick<Subscriber, 'email' | 'name'> = {
  email: 'preview@example.com',
  name: '預覽收件人',
};

export async function previewCampaign(
  ctx: ServiceContext,
  id: string,
  recipient: Pick<Subscriber, 'email' | 'name'> = PREVIEW_RECIPIENT,
): Promise<RenderedEmail & { audienceCount: number }> {
  const campaign = await getCampaign(ctx, id);
  const audience = await ctx.store.listAudience(campaign.audienceTags);
  return { ...renderCampaign(ctx, campaign, recipient), audienceCount: audience.length };
}

/** 封存頁沒有特定收件人，個人化變數一律換成通用值。 */
function publicVariables(ctx: ServiceContext): Record<string, string> {
  return { name: '朋友', email: '', site_name: ctx.config.siteName, unsubscribe_url: '' };
}

export function publicSubject(ctx: ServiceContext, campaign: Campaign): string {
  return applyVariables(campaign.subject, publicVariables(ctx), 'text');
}

/** 公開封存頁用：只吐已寄出的內容，且不帶個人化變數。 */
export async function renderPublicCampaign(
  ctx: ServiceContext,
  slug: string,
): Promise<{ campaign: Campaign; html: string; subject: string } | null> {
  const campaign = await ctx.store.getCampaignBySlug(slug);
  if (!campaign || campaign.status !== 'sent') return null;
  return {
    campaign,
    subject: publicSubject(ctx, campaign),
    html: applyVariables(markdownToHtml(campaign.bodyMarkdown), publicVariables(ctx), 'html'),
  };
}

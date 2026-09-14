import {
  buildBrandSignatureHtml,
  isSignatureLayoutId,
  websiteFromBrand,
} from '../core/brand-signature.js';
import { isSignatureLinkIcon } from '../core/sig-icons.js';
import { applyVariables } from '../core/render.js';
import { badRequest } from '../core/errors.js';
import {
  EMPTY_BRAND,
  type BrandProfile,
  type SignatureLayoutId,
  type SignatureLink,
} from '../store/types.js';
import type { ServiceContext } from './context.js';

const BRAND_KEY = 'brand';
const RAW_KEYS = ['signature'] as const;
const MEDIA_URL = /^\/media\/img_[a-f0-9]{32}\.(jpg|png|gif|webp)$/;
const MAX_LINKS = 12;

function textField(value: unknown, field: string, max: number): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw badRequest(`${field} 格式不對`);
  if (value.length > max) throw badRequest(`${field} 太長（上限 ${max} 字）`);
  return value.trim();
}

function parseLayout(value: unknown): SignatureLayoutId {
  if (typeof value !== 'string' || !isSignatureLayoutId(value)) return EMPTY_BRAND.signatureLayout;
  return value;
}

function parseLinks(value: unknown): SignatureLink[] {
  if (!Array.isArray(value)) return [];
  const links: SignatureLink[] = [];
  for (const item of value.slice(0, MAX_LINKS)) {
    if (!item || typeof item !== 'object') continue;
    const row = item as { id?: unknown; icon?: unknown; url?: unknown };
    if (typeof row.icon !== 'string' || !isSignatureLinkIcon(row.icon)) continue;
    const url = typeof row.url === 'string' ? row.url.trim() : '';
    const id =
      typeof row.id === 'string' && row.id.trim()
        ? row.id.trim().slice(0, 40)
        : `slk_${links.length + 1}`;
    links.push({ id, icon: row.icon, url });
  }
  return links;
}

function parseAvatarUrl(value: unknown): string {
  if (typeof value !== 'string') return '';
  const url = value.trim();
  if (!url) return '';
  return MEDIA_URL.test(url) ? url : '';
}

export function parseBrand(raw?: string): BrandProfile {
  if (!raw) return { ...EMPTY_BRAND };
  try {
    const parsed = JSON.parse(raw) as Partial<BrandProfile>;
    return {
      writerName: typeof parsed.writerName === 'string' ? parsed.writerName : '',
      websiteUrl: typeof parsed.websiteUrl === 'string' ? parsed.websiteUrl : '',
      organization: typeof parsed.organization === 'string' ? parsed.organization : '',
      title: typeof parsed.title === 'string' ? parsed.title : '',
      tagline: typeof parsed.tagline === 'string' ? parsed.tagline : '',
      avatarUrl: parseAvatarUrl(parsed.avatarUrl),
      signatureLayout: parseLayout(parsed.signatureLayout),
      signatureLinks: parseLinks(parsed.signatureLinks),
      signatureHtml: typeof parsed.signatureHtml === 'string' ? parsed.signatureHtml : '',
    };
  } catch {
    return { ...EMPTY_BRAND };
  }
}

export async function getBrand(ctx: ServiceContext): Promise<BrandProfile> {
  return parseBrand(await ctx.store.getSetting(BRAND_KEY));
}

export interface BrandUpdateInput {
  writerName?: unknown;
  websiteUrl?: unknown;
  organization?: unknown;
  title?: unknown;
  tagline?: unknown;
  avatarUrl?: unknown;
  signatureLayout?: unknown;
  signatureLinks?: unknown;
  signatureHtml?: unknown;
}

export async function updateBrand(ctx: ServiceContext, input: BrandUpdateInput): Promise<BrandProfile> {
  const current = await getBrand(ctx);
  if (input.signatureLayout !== undefined && typeof input.signatureLayout === 'string' && !isSignatureLayoutId(input.signatureLayout)) {
    throw badRequest('沒有這個簽名版型');
  }
  if (input.signatureLinks !== undefined && !Array.isArray(input.signatureLinks)) {
    throw badRequest('連結格式不對');
  }
  if (Array.isArray(input.signatureLinks) && input.signatureLinks.length > MAX_LINKS) {
    throw badRequest(`連結最多 ${MAX_LINKS} 個`);
  }
  if (input.avatarUrl !== undefined && typeof input.avatarUrl === 'string' && input.avatarUrl.trim() && !MEDIA_URL.test(input.avatarUrl.trim())) {
    throw badRequest('大頭貼請從本機上傳');
  }

  const links = input.signatureLinks === undefined ? current.signatureLinks : parseLinks(input.signatureLinks);
  const next: BrandProfile = {
    writerName: input.writerName === undefined ? current.writerName : textField(input.writerName, '顯示名稱', 80),
    websiteUrl: input.websiteUrl === undefined ? current.websiteUrl : textField(input.websiteUrl, '網站', 500),
    organization: input.organization === undefined ? current.organization : textField(input.organization, '單位名稱', 80),
    title: input.title === undefined ? current.title : textField(input.title, '抬頭', 80),
    tagline: input.tagline === undefined ? current.tagline : textField(input.tagline, '一句話', 160),
    avatarUrl: input.avatarUrl === undefined ? current.avatarUrl : parseAvatarUrl(input.avatarUrl),
    signatureLayout: input.signatureLayout === undefined ? current.signatureLayout : parseLayout(input.signatureLayout),
    signatureLinks: links.map((item) => ({ ...item, url: item.url.slice(0, 500) })),
    signatureHtml: '',
  };
  const website = websiteFromBrand(next);
  if (input.websiteUrl === undefined) next.websiteUrl = website;
  next.signatureHtml = buildBrandSignatureHtml(next);
  if (next.signatureHtml.length > 20_000) throw badRequest('簽名檔太長（上限 20000 字）');
  await ctx.store.setSetting(BRAND_KEY, JSON.stringify(next));
  return next;
}

export function mergeBrandVariables(
  base: Record<string, string>,
  brand: BrandProfile,
  publicBaseUrl?: string,
): Record<string, string> {
  const writer = brand.writerName;
  const website = websiteFromBrand(brand);
  const source = buildBrandSignatureHtml(brand, { publicBaseUrl });
  const signature = applyVariables(source, { ...base, writer, website }, 'html');
  return { ...base, writer, website, signature };
}

export function applyCampaignVariables(
  template: string,
  variables: Record<string, string>,
  mode: 'html' | 'text' = 'html',
): string {
  return applyVariables(template, variables, mode, { raw: RAW_KEYS });
}

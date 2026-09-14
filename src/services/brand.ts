import { buildBrandSignatureHtml } from '../core/brand-signature.js';
import { applyVariables } from '../core/render.js';
import { badRequest } from '../core/errors.js';
import { EMPTY_BRAND, type BrandProfile } from '../store/types.js';
import type { ServiceContext } from './context.js';

const BRAND_KEY = 'brand';
const RAW_KEYS = ['signature'] as const;

function textField(value: unknown, field: string, max: number): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw badRequest(`${field} 格式不對`);
  if (value.length > max) throw badRequest(`${field} 太長（上限 ${max} 字）`);
  return value.trim();
}

export function parseBrand(raw?: string): BrandProfile {
  if (!raw) return { ...EMPTY_BRAND };
  try {
    const parsed = JSON.parse(raw) as Partial<BrandProfile>;
    return {
      writerName: typeof parsed.writerName === 'string' ? parsed.writerName : '',
      websiteUrl: typeof parsed.websiteUrl === 'string' ? parsed.websiteUrl : '',
      signatureHtml: typeof parsed.signatureHtml === 'string' ? parsed.signatureHtml : '',
    };
  } catch {
    return { ...EMPTY_BRAND };
  }
}

export async function getBrand(ctx: ServiceContext): Promise<BrandProfile> {
  return parseBrand(await ctx.store.getSetting(BRAND_KEY));
}

export async function updateBrand(
  ctx: ServiceContext,
  input: { writerName?: unknown; websiteUrl?: unknown; signatureHtml?: unknown },
): Promise<BrandProfile> {
  const current = await getBrand(ctx);
  const next: BrandProfile = {
    writerName: input.writerName === undefined ? current.writerName : textField(input.writerName, '顯示名稱', 80),
    websiteUrl: input.websiteUrl === undefined ? current.websiteUrl : textField(input.websiteUrl, '網站', 500),
    signatureHtml:
      input.signatureHtml === undefined
        ? current.signatureHtml
        : textField(input.signatureHtml, '簽名檔', 20_000),
  };
  await ctx.store.setSetting(BRAND_KEY, JSON.stringify(next));
  return next;
}

export function mergeBrandVariables(
  base: Record<string, string>,
  brand: BrandProfile,
): Record<string, string> {
  const writer = brand.writerName;
  const website = brand.websiteUrl;
  const source = brand.signatureHtml.trim() || buildBrandSignatureHtml(writer, website);
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

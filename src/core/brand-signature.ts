import {
  EMPTY_BRAND,
  SIGNATURE_LAYOUT_IDS,
  type BrandProfile,
  type SignatureLayoutId,
  type SignatureLink,
  type SignatureLinkIcon,
} from '../store/types.js';
import { sigIconUrl } from './sig-icons.js';
import { escapeHtml } from './render.js';

const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans TC','PingFang TC',sans-serif";

export const SIGNATURE_LAYOUTS: { id: SignatureLayoutId; name: string; description: string }[] = [
  { id: 'avatar-left', name: '左側大頭貼', description: '照片在左，文字在右' },
  { id: 'avatar-center', name: '置中大頭貼', description: '照片在上，文字置中' },
  { id: 'text-only', name: '無大頭貼', description: '只排文字與連結' },
];

export const SIGNATURE_LINK_META: { id: SignatureLinkIcon; label: string; hosts: string[] }[] = [
  { id: 'website', label: '官網', hosts: [] },
  { id: 'email', label: '電子郵件', hosts: [] },
  { id: 'instagram', label: 'Instagram', hosts: ['instagram.com'] },
  { id: 'facebook', label: 'Facebook', hosts: ['facebook.com', 'fb.com', 'fb.me'] },
  { id: 'threads', label: 'Threads', hosts: ['threads.net', 'threads.com'] },
  { id: 'youtube', label: 'YouTube', hosts: ['youtube.com', 'youtu.be'] },
  { id: 'x', label: 'X', hosts: ['x.com', 'twitter.com'] },
  { id: 'linkedin', label: 'LinkedIn', hosts: ['linkedin.com'] },
  { id: 'podcast', label: 'Podcast', hosts: ['podcasts.apple.com', 'open.spotify.com', 'pca.st'] },
  { id: 'shop', label: '商店', hosts: ['myshopify.com'] },
];

export function isSignatureLayoutId(value: string): value is SignatureLayoutId {
  return (SIGNATURE_LAYOUT_IDS as readonly string[]).includes(value);
}

export function brandWebsiteHref(websiteUrl: string): string {
  const website = websiteUrl.trim();
  if (!website) return '';
  return /^https?:\/\//i.test(website) ? website : `https://${website}`;
}

export function brandLinkHref(url: string, icon: SignatureLinkIcon): string {
  const value = url.trim();
  if (!value) return '';
  if (/^\s*(javascript|data|vbscript):/i.test(value)) return '';
  if (icon === 'email') {
    if (/^mailto:/i.test(value) || /^https?:\/\//i.test(value)) return value;
    return `mailto:${value}`;
  }
  return brandWebsiteHref(value);
}

export function guessSignatureLinkIcon(url: string): SignatureLinkIcon {
  const value = url.trim();
  if (!value) return 'website';
  if (/^mailto:/i.test(value) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return 'email';
  let host = '';
  try {
    host = new URL(brandWebsiteHref(value)).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return 'website';
  }
  for (const item of SIGNATURE_LINK_META) {
    if (item.hosts.some((known) => host === known || host.endsWith(`.${known}`))) return item.id;
  }
  if (host.includes('shop') || host.includes('store')) return 'shop';
  return 'website';
}

export function websiteFromBrand(brand: Pick<BrandProfile, 'websiteUrl' | 'signatureLinks'>): string {
  const linked = brand.signatureLinks.find((item) => item.icon === 'website' && item.url.trim());
  if (linked) return brandLinkHref(linked.url, 'website');
  return brandWebsiteHref(brand.websiteUrl);
}

function effectiveLinks(brand: BrandProfile): SignatureLink[] {
  const listed = brand.signatureLinks.filter((item) => item.url.trim());
  if (listed.length > 0) return listed;
  if (brand.websiteUrl.trim()) {
    return [{ id: 'website', icon: 'website', url: brand.websiteUrl.trim() }];
  }
  return [];
}

function hasSignatureContent(brand: BrandProfile): boolean {
  return Boolean(
    brand.writerName.trim() ||
      brand.title.trim() ||
      brand.organization.trim() ||
      brand.tagline.trim() ||
      (brand.signatureLayout !== 'text-only' && brand.avatarUrl.trim()) ||
      effectiveLinks(brand).length > 0,
  );
}

function avatarMarkup(src: string, size: number, alt: string): string {
  return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" width="${size}" height="${size}" style="width:${size}px;height:${size}px;border-radius:${Math.round(size / 2)}px;object-fit:cover;display:block;border:0;" />`;
}

function textBlock(brand: BrandProfile, align: 'left' | 'center'): string {
  const alignCss = `text-align:${align};`;
  const parts: string[] = [];
  const name = brand.writerName.trim();
  const title = brand.title.trim();
  const org = brand.organization.trim();
  const tagline = brand.tagline.trim();
  if (name) {
    parts.push(
      `<p style="margin:0 0 4px;${alignCss}font:600 16px/1.4 ${FONT};color:#1c1917;">${escapeHtml(name)}</p>`,
    );
  }
  if (title) {
    parts.push(
      `<p style="margin:0 0 2px;${alignCss}font:400 13px/1.5 ${FONT};color:#78716c;">${escapeHtml(title)}</p>`,
    );
  }
  if (org) {
    parts.push(
      `<p style="margin:0 0 2px;${alignCss}font:400 13px/1.5 ${FONT};color:#78716c;">${escapeHtml(org)}</p>`,
    );
  }
  if (tagline) {
    parts.push(
      `<p style="margin:0;${alignCss}font:400 13px/1.55 ${FONT};color:#44403c;">${escapeHtml(tagline)}</p>`,
    );
  }
  return parts.join('');
}

function iconRow(links: SignatureLink[], align: 'left' | 'center', publicBaseUrl?: string): string {
  const cells = links
    .map((item) => {
      const href = brandLinkHref(item.url, item.icon);
      if (!href) return '';
      const meta = SIGNATURE_LINK_META.find((entry) => entry.id === item.icon);
      const alt = meta?.label ?? item.icon;
      const src = sigIconUrl(item.icon, publicBaseUrl);
      return `<td style="padding:0 10px 0 0;"><a href="${escapeHtml(href)}" style="display:block;line-height:0;"><img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" width="20" height="20" style="display:block;border:0;width:20px;height:20px;" /></a></td>`;
    })
    .filter(Boolean);
  if (cells.length === 0) return '';
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="${align}" style="margin:12px 0 0;"><tr>${cells.join('')}</tr></table>`;
}

export interface BuildSignatureOptions {
  publicBaseUrl?: string | undefined;
  previewAvatar?: string | undefined;
}

export function buildBrandSignatureHtml(
  brand: BrandProfile,
  options: BuildSignatureOptions = {},
): string {
  if (!hasSignatureContent(brand)) return '';
  const layout = isSignatureLayoutId(brand.signatureLayout) ? brand.signatureLayout : 'avatar-left';
  const align: 'left' | 'center' = layout === 'avatar-center' ? 'center' : 'left';
  const avatarSrc =
    layout === 'text-only' ? '' : brand.avatarUrl.trim() || options.previewAvatar?.trim() || '';
  const text = textBlock(brand, align);
  const icons = iconRow(effectiveLinks(brand), align, options.publicBaseUrl);
  const nameAlt = brand.writerName.trim() || '大頭貼';

  let inner = '';
  if (layout === 'avatar-left' && avatarSrc) {
    inner = `<table role="presentation" cellpadding="0" cellspacing="0" border="0">
  <tr>
    <td valign="top" style="padding:0 16px 0 0;">${avatarMarkup(avatarSrc, 64, nameAlt)}</td>
    <td valign="middle">${text}${icons}</td>
  </tr>
</table>`;
  } else if (layout === 'avatar-center' && avatarSrc) {
    inner = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr><td align="center" style="padding:0 0 12px;">${avatarMarkup(avatarSrc, 72, nameAlt)}</td></tr>
  <tr><td align="center">${text}${icons}</td></tr>
</table>`;
  } else {
    inner = `${text}${icons}`;
  }

  if (!inner) return '';
  return `<table data-email-signature="1" role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 0;">
  <tr>
    <td style="padding:20px 0 0;border-top:1px solid #e7e5e4;">${inner}</td>
  </tr>
</table>`;
}

/** @deprecated 舊的兩欄位呼叫仍可用，轉成完整簽名再渲染。 */
export function buildLegacyBrandSignatureHtml(writerName: string, websiteUrl: string): string {
  return buildBrandSignatureHtml({ ...EMPTY_BRAND, writerName, websiteUrl, signatureLayout: 'text-only' });
}

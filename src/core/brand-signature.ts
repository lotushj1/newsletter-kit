import { escapeHtml } from './render.js';

export function brandWebsiteHref(websiteUrl: string): string {
  const website = websiteUrl.trim();
  if (!website) return '';
  return /^https?:\/\//i.test(website) ? website : `https://${website}`;
}

export function buildBrandSignatureHtml(writerName: string, websiteUrl: string): string {
  const name = writerName.trim();
  const website = websiteUrl.trim();
  if (!name && !website) return '';
  const parts: string[] = [];
  if (name) parts.push(`<p>${escapeHtml(name)}</p>`);
  if (website) {
    parts.push(
      `<p><a href="${escapeHtml(brandWebsiteHref(website))}">${escapeHtml(website.replace(/^https?:\/\//i, ''))}</a></p>`,
    );
  }
  return parts.join('');
}

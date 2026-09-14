import type { BrandProfile } from '../store/types.js';
import { buildBrandSignatureHtml } from './brand-signature.js';
import { applyVariables, htmlToText, renderEmailLayout } from './render.js';

export const PREVIEW_RECIPIENT = {
  email: 'preview@example.com',
  name: '預覽收件人',
};

export interface PreviewEmailInput {
  bodyHtml: string;
  subject?: string;
  preheader?: string;
  siteName: string;
  publicBaseUrl?: string;
  brand: BrandProfile;
}

/** 跟後台「預覽」同一條路：變數 → 品牌簽名 → email 版型。 */
export function renderPreviewEmail(input: PreviewEmailInput): { subject: string; html: string; text: string } {
  const writer = input.brand.writerName;
  const website = input.brand.websiteUrl;
  const base = {
    name: PREVIEW_RECIPIENT.name,
    email: PREVIEW_RECIPIENT.email,
    site_name: input.siteName,
    unsubscribe_url: '',
    writer,
    website,
  };
  const source = input.brand.signatureHtml.trim() || buildBrandSignatureHtml(writer, website);
  const variables = { ...base, signature: applyVariables(source, base, 'html') };
  const subject = applyVariables(input.subject || '預覽', variables, 'text');
  const html = renderEmailLayout({
    subject,
    preheader: input.preheader ? applyVariables(input.preheader, variables, 'text') : undefined,
    contentHtml: applyVariables(input.bodyHtml, variables, 'html', { raw: ['signature'] }),
    siteName: input.siteName,
    publicBaseUrl: input.publicBaseUrl,
    unsubscribeUrl: '#',
  });
  return { subject, html, text: htmlToText(html) };
}

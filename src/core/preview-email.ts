import type { BrandProfile } from '../store/types.js';
import {
  attachBrandSignature,
  buildBrandSignatureHtml,
  emailBrandName,
  unwrapSignatureToken,
  websiteFromBrand,
} from './brand-signature.js';
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
  /** 模板縮圖傳 `placeholder`，空位會畫成占位圖；其餘預覽照寄出的樣子拿掉空位。 */
  imageSlots?: 'drop' | 'placeholder';
}

/** 跟後台「預覽」同一條路：變數 → 品牌簽名 → email 版型。 */
export function renderPreviewEmail(input: PreviewEmailInput): { subject: string; html: string; text: string } {
  const writer = input.brand.writerName;
  const website = websiteFromBrand(input.brand);
  const brandName = emailBrandName(input.brand, input.siteName);
  const base = {
    name: PREVIEW_RECIPIENT.name,
    email: PREVIEW_RECIPIENT.email,
    site_name: brandName || input.siteName,
    unsubscribe_url: '',
    writer,
    website,
  };
  const source = buildBrandSignatureHtml(input.brand, { publicBaseUrl: input.publicBaseUrl });
  const variables = { ...base, signature: applyVariables(source, base, 'html') };
  const subject = applyVariables(input.subject || '預覽', variables, 'text');
  const html = renderEmailLayout({
    subject,
    preheader: input.preheader ? applyVariables(input.preheader, variables, 'text') : undefined,
    contentHtml: attachBrandSignature(
      applyVariables(unwrapSignatureToken(input.bodyHtml), variables, 'html', { raw: ['signature'] }),
      variables.signature,
    ),
    siteName: brandName,
    publicBaseUrl: input.publicBaseUrl,
    unsubscribeUrl: '#',
    unsubscribePrompt: input.brand.unsubscribePrompt,
    unsubscribeLabel: input.brand.unsubscribeLabel,
    imageSlots: input.imageSlots,
  });
  return { subject, html, text: htmlToText(html) };
}

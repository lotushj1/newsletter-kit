import { markdownToHtml } from './render.js';

/** Tiptap 空文件常是 `<p></p>`，不能只看 trim。 */
export function isBlankHtml(html: string): boolean {
  return html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim() === '';
}

export function campaignContentHtml(campaign: { bodyHtml: string; bodyMarkdown: string }): string {
  if (!isBlankHtml(campaign.bodyHtml)) return campaign.bodyHtml;
  return markdownToHtml(campaign.bodyMarkdown ?? '');
}

export function campaignHasBody(campaign: { bodyHtml: string; bodyMarkdown: string }): boolean {
  return !isBlankHtml(campaign.bodyHtml) || (campaign.bodyMarkdown ?? '').trim() !== '';
}

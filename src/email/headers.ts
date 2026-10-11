import type { EmailMessage } from './types.js';

/** Build RFC 8058 headers once, then let each transport map them to its API. */
export function emailHeaders(message: EmailMessage): Record<string, string> {
  const headers = { ...message.headers };
  if (message.unsubscribeUrl) {
    const links = [`<${message.unsubscribeUrl}>`];
    if (message.unsubscribeMailto && /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(message.unsubscribeMailto)) links.push(`<mailto:${message.unsubscribeMailto}>`);
    headers['List-Unsubscribe'] = links.join(', ');
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }
  return headers;
}

export function withEmailHeaders(message: EmailMessage): EmailMessage {
  return { ...message, headers: emailHeaders(message) };
}

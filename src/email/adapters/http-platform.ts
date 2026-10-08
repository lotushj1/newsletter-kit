import type { EmailAdapter, EmailAdapterFactory, EmailMessage, SendResult } from '../types.js';
import { getEmailPlatform } from '../providers.js';

interface Address {
  email: string;
  name?: string;
}

export interface PlatformRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function address(value: string): Address {
  const match = value.trim().match(/^(.*)<([^>]+)>\s*$/);
  const email = match?.[2]?.trim();
  if (!email) return { email: value.trim() };
  const name = (match?.[1] ?? '').trim().replace(/^"|"$/g, '');
  return name ? { email, name } : { email };
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

export function platformRequest(
  id: string,
  input: { apiKey: string; apiExtra?: string | undefined },
  message: EmailMessage,
): PlatformRequest | { error: string } {
  const key = input.apiKey.trim();
  const extra = input.apiExtra?.trim() ?? '';
  const from = address(message.from);
  const reply = message.replyTo ? address(message.replyTo) : undefined;
  if (!key) return { error: '缺少 API 金鑰' };

  if (id === 'postmark') {
    return {
      url: 'https://api.postmarkapp.com/email',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-postmark-server-token': key,
      },
      body: json({
        From: message.from,
        To: message.to,
        Subject: message.subject,
        HtmlBody: message.html,
        TextBody: message.text,
        ReplyTo: message.replyTo,
        MessageStream: 'outbound',
        Headers: message.unsubscribeUrl
          ? [{ Name: 'List-Unsubscribe', Value: `<${message.unsubscribeUrl}>` }]
          : undefined,
      }),
    };
  }

  if (id === 'sendgrid') {
    return {
      url: 'https://api.sendgrid.com/v3/mail/send',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: json({
        personalizations: [{ to: [{ email: message.to }] }],
        from,
        reply_to: reply,
        subject: message.subject,
        content: [
          message.text ? { type: 'text/plain', value: message.text } : undefined,
          { type: 'text/html', value: message.html },
        ].filter(Boolean),
        headers: message.unsubscribeUrl ? { 'List-Unsubscribe': `<${message.unsubscribeUrl}>` } : undefined,
      }),
    };
  }

  if (id === 'mailgun') {
    if (!extra || /\s/.test(extra)) return { error: '要填寄信網域' };
    const form = new URLSearchParams();
    form.set('from', message.from);
    form.set('to', message.to);
    form.set('subject', message.subject);
    form.set('html', message.html);
    if (message.text) form.set('text', message.text);
    if (message.replyTo) form.set('h:Reply-To', message.replyTo);
    if (message.unsubscribeUrl) form.set('h:List-Unsubscribe', `<${message.unsubscribeUrl}>`);
    return {
      url: `https://api.mailgun.net/v3/${encodeURIComponent(extra)}/messages`,
      headers: {
        authorization: `Basic ${Buffer.from(`api:${key}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    };
  }

  if (id === 'brevo') {
    return {
      url: 'https://api.brevo.com/v3/smtp/email',
      headers: { 'api-key': key, 'content-type': 'application/json', accept: 'application/json' },
      body: json({
        sender: from,
        to: [{ email: message.to }],
        replyTo: reply,
        subject: message.subject,
        htmlContent: message.html,
        textContent: message.text,
      }),
    };
  }

  if (id === 'mailchimp') {
    return {
      url: 'https://mandrillapp.com/api/1.0/messages/send.json',
      headers: { 'content-type': 'application/json' },
      body: json({
        key,
        message: {
          from_email: from.email,
          from_name: from.name,
          to: [{ email: message.to, type: 'to' }],
          subject: message.subject,
          html: message.html,
          text: message.text,
          headers: message.unsubscribeUrl ? { 'List-Unsubscribe': `<${message.unsubscribeUrl}>` } : undefined,
        },
      }),
    };
  }

  if (id === 'sparkpost') {
    return {
      url: 'https://api.sparkpost.com/api/v1/transmissions',
      headers: { authorization: key, 'content-type': 'application/json' },
      body: json({
        recipients: [{ address: { email: message.to } }],
        content: {
          from: message.from,
          subject: message.subject,
          html: message.html,
          text: message.text,
          reply_to: message.replyTo,
        },
      }),
    };
  }

  if (id === 'mailersend') {
    return {
      url: 'https://api.mailersend.com/v1/email',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: json({
        from,
        to: [{ email: message.to }],
        reply_to: reply,
        subject: message.subject,
        html: message.html,
        text: message.text,
      }),
    };
  }

  if (id === 'plunk') {
    return {
      url: 'https://api.useplunk.com/v1/send',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: json({
        to: message.to,
        subject: message.subject,
        body: message.html,
        from: from.email,
      }),
    };
  }

  if (id === 'smtp2go') {
    return {
      url: 'https://api.smtp2go.com/v3/email/send',
      headers: { 'content-type': 'application/json' },
      body: json({
        api_key: key,
        sender: message.from,
        to: [message.to],
        subject: message.subject,
        html_body: message.html,
        text_body: message.text,
      }),
    };
  }

  if (id === 'elasticemail') {
    return {
      url: 'https://api.elasticemail.com/v4/emails',
      headers: { 'x-elasticemail-apikey': key, 'content-type': 'application/json' },
      body: json({
        Recipients: [{ Email: message.to }],
        Content: {
          From: message.from,
          Subject: message.subject,
          Body: [{ ContentType: 'HTML', Content: message.html, Charset: 'utf-8' }],
        },
      }),
    };
  }

  if (id === 'postal') {
    if (!/^https?:\/\//i.test(extra)) return { error: '端點要以 http:// 或 https:// 開頭' };
    return {
      url: `${extra.replace(/\/+$/, '')}/api/v1/send/message`,
      headers: { 'x-server-api-key': key, 'content-type': 'application/json' },
      body: json({
        to: [message.to],
        from: message.from,
        subject: message.subject,
        html_body: message.html,
        plain_body: message.text,
        reply_to: message.replyTo,
      }),
    };
  }

  if (id === 'scaleway') {
    if (!extra) return { error: '要填 Project ID' };
    return {
      url: 'https://api.scaleway.com/transactional-email/v1alpha1/regions/fr-par/emails',
      headers: { 'x-auth-token': key, 'content-type': 'application/json' },
      body: json({
        from,
        to: [{ email: message.to }],
        subject: message.subject,
        html: message.html,
        text: message.text,
        project_id: extra,
      }),
    };
  }

  return { error: '沒有這個寄信管道' };
}

async function deliver(request: PlatformRequest, label: string): Promise<SendResult> {
  try {
    const response = await fetch(request.url, { method: 'POST', headers: request.headers, body: request.body });
    const raw = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        error: `${label} ${response.status}: ${raw.slice(0, 300)}`,
        retryable: response.status >= 500 || response.status === 429,
      };
    }
    let id: string | undefined;
    try {
      const parsed = JSON.parse(raw) as { id?: string; MessageID?: string };
      id = parsed.id ?? parsed.MessageID;
    } catch {
      id = undefined;
    }
    return { ok: true, id };
  } catch (error) {
    return { ok: false, error: `${label} 連線失敗：${(error as Error).message}`, retryable: true };
  }
}

export const createHttpPlatformAdapter: (id: string) => EmailAdapterFactory = (id) => (context) => ({
  name: id,

  async verify() {
    const platform = getEmailPlatform(id);
    const built = platformRequest(id, { apiKey: context.apiKey ?? '', apiExtra: context.apiExtra }, {
      to: 'reader@example.com',
      from: 'Newsletter <news@example.com>',
      subject: 'verify',
      html: '<p>verify</p>',
    });
    if ('error' in built) return { ok: false, message: built.error };
    return { ok: true, message: `已設定 ${platform?.label ?? id}。寄出時才會打它的 API。` };
  },

  async send(message) {
    const built = platformRequest(id, { apiKey: context.apiKey ?? '', apiExtra: context.apiExtra }, message);
    if ('error' in built) return { ok: false, error: built.error, retryable: false };
    return deliver(built, getEmailPlatform(id)?.label ?? id);
  },
});

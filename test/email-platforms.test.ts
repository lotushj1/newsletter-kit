import { describe, expect, it } from 'vitest';
import { platformRequest } from '../src/email/adapters/http-platform.ts';
import { EMAIL_PLATFORMS } from '../src/email/providers.ts';
import type { EmailMessage } from '../src/email/types.ts';

const message: EmailMessage = {
  to: 'reader@example.com',
  from: 'News <news@example.com>',
  replyTo: 'hello@example.com',
  subject: '你好',
  html: '<p>嗨</p>',
  text: '嗨',
};

describe('寄信平台清單', () => {
  it('常用和較少用的平台都在', () => {
    const common = EMAIL_PLATFORMS.filter((item) => item.group === 'common').map((item) => item.id);
    const more = EMAIL_PLATFORMS.filter((item) => item.group === 'more').map((item) => item.id);
    expect(common).toEqual(['resend', 'postmark', 'sendgrid', 'mailgun', 'brevo', 'mailchimp', 'ses']);
    expect(more).toEqual(['sparkpost', 'mailersend', 'plunk', 'smtp2go', 'elasticemail', 'postal', 'scaleway', 'zeabur', 'insforge']);
  });

  it('Postmark 用 Server Token，不把金鑰放進網址', () => {
    const request = platformRequest('postmark', { apiKey: 'pm-secret' }, message);
    expect(request).toMatchObject({
      url: 'https://api.postmarkapp.com/email',
      headers: { 'x-postmark-server-token': 'pm-secret' },
    });
    if (!('body' in request)) throw new Error('expected body');
    expect(request.body).toContain('HtmlBody');
    expect(request.url).not.toContain('pm-secret');
  });

  it('Mailgun 沒有網域時不會組請求', () => {
    expect(platformRequest('mailgun', { apiKey: 'key' }, message)).toEqual({ error: '要填寄信網域' });
    const request = platformRequest('mailgun', { apiKey: 'key', apiExtra: 'mg.example.com' }, message);
    expect(request).toMatchObject({ url: 'https://api.mailgun.net/v3/mg.example.com/messages' });
  });

  it('Postal 端點必須是網址', () => {
    expect(platformRequest('postal', { apiKey: 'key', apiExtra: 'postal.example.com' }, message)).toEqual({
      error: '端點要以 http:// 或 https:// 開頭',
    });
  });
});

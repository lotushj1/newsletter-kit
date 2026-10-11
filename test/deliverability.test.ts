import { createHmac, generateKeyPairSync, sign } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/http/app.js';
import { makeContext } from './helpers.js';

const email = 'reader@example.com';
const topic = 'arn:aws:sns:us-east-1:123456789012:newsletter';
const secrets = {
  resend: 'whsec_' + Buffer.from('secret-key').toString('base64'),
  sesTopicArn: topic, postmark: 'post-secret', sendgrid: '', mailgun: 'mailgun-secret',
  brevo: 'brevo-secret', mailchimp: 'mandrill-secret', generic: 'generic-secret',
  mailersend: 'mailer-secret', sparkpost: 'spark-secret', smtp2go: 'smtp-secret',
  plunk: 'plunk-secret',
};
const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
secrets.sendgrid = ec.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function signature(provider: string, body: string): { headers: Record<string, string>; url?: string } {
  const h = (key: string, data: string, algo = 'sha256', encoding: 'hex' | 'base64' = 'hex') => createHmac(algo, key).update(data).digest(encoding);
  if (provider === 'resend') {
    const timestamp = String(Math.floor(Date.now() / 1000)); const id = 'msg_123';
    return { headers: { 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': 'v1,' + createHmac('sha256', Buffer.from(secrets.resend.slice(6), 'base64')).update(`${id}.${timestamp}.${body}`).digest('base64') } };
  }
  if (provider === 'postmark' || provider === 'brevo' || provider === 'smtp2go' || provider === 'plunk') return { headers: { authorization: `Bearer ${secrets[provider]}` } };
  if (provider === 'sendgrid') {
    const timestamp = String(Math.floor(Date.now() / 1000));
    return { headers: { 'x-twilio-email-event-webhook-timestamp': timestamp, 'x-twilio-email-event-webhook-signature': sign('sha256', Buffer.from(timestamp + body), ec.privateKey).toString('base64') } };
  }
  if (provider === 'mailgun') return { headers: {} };
  if (provider === 'mailchimp') {
    const url = 'https://newsletter.test/api/webhooks/mailchimp';
    const params = new URLSearchParams(body);
    const values = [...params.keys()].sort().map((key) => key + params.get(key)).join('');
    return { headers: { 'x-mandrill-signature': h(secrets.mailchimp, url + values, 'sha1', 'base64') } };
  }
  if (provider === 'mailersend') return { headers: { signature: h(secrets.mailersend, body) } };
  if (provider === 'sparkpost') return { headers: { 'x-messagesystems-webhook-token': secrets.sparkpost } };
  if (provider === 'generic') return { headers: { 'x-newsletter-signature': 'sha256=' + h(secrets.generic, body) } };
  return { headers: {} };
}

function event(provider: string, kind: 'bounce' | 'complaint' | 'soft'): { body: string; type?: string } {
  if (provider === 'resend') return { body: JSON.stringify({ type: kind === 'complaint' ? 'email.complained' : kind === 'soft' ? 'email.delivery_delayed' : 'email.bounced', data: { to: [email] } }) };
  if (provider === 'postmark') return { body: JSON.stringify({ Type: kind === 'complaint' ? 'SpamComplaint' : kind === 'soft' ? 'SoftBounce' : 'HardBounce', Email: email }) };
  if (provider === 'sendgrid') return { body: JSON.stringify([{ event: kind === 'complaint' ? 'spamreport' : kind === 'soft' ? 'deferred' : 'bounce', email }]) };
  if (provider === 'mailgun') {
    const timestamp = String(Math.floor(Date.now() / 1000)); const token = 'token';
    return { body: JSON.stringify({ signature: { timestamp, token, signature: createHmac('sha256', secrets.mailgun).update(timestamp + token).digest('hex') }, 'event-data': { event: kind === 'complaint' ? 'complained' : 'failed', recipient: email, 'delivery-status': { severity: kind === 'soft' ? 'temporary' : 'permanent' } } }) };
  }
  if (provider === 'brevo') return { body: JSON.stringify({ event: kind === 'complaint' ? 'spam' : kind === 'soft' ? 'soft_bounce' : 'hard_bounce', email }) };
  if (provider === 'mailchimp') return { body: new URLSearchParams({ mandrill_events: JSON.stringify([{ event: kind === 'complaint' ? 'spam' : kind === 'soft' ? 'soft_bounce' : 'hard_bounce', msg: { email } }]) }).toString(), type: 'application/x-www-form-urlencoded' };
  if (provider === 'mailersend') return { body: JSON.stringify({ type: `activity.${kind === 'complaint' ? 'spam_complaint' : kind === 'soft' ? 'soft_bounced' : 'hard_bounced'}`, data: { recipient: email } }) };
  if (provider === 'sparkpost') return { body: JSON.stringify([{ msys: { message_event: { type: kind === 'complaint' ? 'spam_complaint' : 'bounce', bounce_class: kind === 'soft' ? 20 : 10, rcpt_to: email } } }]) };
  if (provider === 'smtp2go') return { body: JSON.stringify({ event: kind === 'complaint' ? 'spam' : 'bounce', bounce: kind === 'soft' ? 'soft' : 'hard', rcpt: email }) };
  if (provider === 'plunk') return { body: JSON.stringify({ contact: { email }, event: kind === 'complaint' ? { complainedAt: new Date().toISOString(), emailId: 'email_1' } : { bounceType: kind === 'soft' ? 'Transient' : 'Permanent', emailId: 'email_1' } }) };
  return { body: JSON.stringify({ type: kind === 'complaint' ? 'complaint' : kind === 'soft' ? 'soft_bounce' : 'hard_bounce', email }) };
}

async function withServer(run: (base: string, ctx: Awaited<ReturnType<typeof makeContext>>['ctx']) => Promise<void>) {
  const made = await makeContext({ webhookSecrets: secrets });
  await made.store.createSubscriber({ id: 'sub_1', email, status: 'subscribed', tags: [], createdAt: new Date().toISOString() });
  const server = createApp(made.ctx).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, made.ctx); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

for (const provider of ['resend', 'postmark', 'sendgrid', 'mailgun', 'brevo', 'mailchimp', 'mailersend', 'sparkpost', 'smtp2go', 'plunk', 'generic']) {
  describe(`${provider} webhook`, () => {
    it('rejects an invalid signature and suppresses a verified hard bounce idempotently', async () => withServer(async (base, ctx) => {
      const { body, type } = event(provider, 'bounce');
      const path = `/api/webhooks/${provider}`;
      const badBody = provider === 'mailgun' ? body.replace(/"signature":"[a-f0-9]+"/, '"signature":"bad"') : body;
      const bad = await originalFetch(base + path, { method: 'POST', headers: { 'content-type': type ?? 'application/json' }, body: badBody });
      expect(bad.status).toBe(401);
      expect((await ctx.store.getSubscriberByEmail(email))?.status).toBe('subscribed');
      const headers = { 'content-type': type ?? 'application/json', ...signature(provider, body).headers };
      for (let i = 0; i < 2; i++) expect((await originalFetch(base + path, { method: 'POST', headers, body })).status).toBe(200);
      expect((await ctx.store.getSubscriberByEmail(email))?.status).toBe('bounced');
    }));
    it('unsubscribes complaints and ignores soft bounces', async () => withServer(async (base, ctx) => {
      const path = `/api/webhooks/${provider}`;
      const soft = event(provider, 'soft');
      expect((await originalFetch(base + path, { method: 'POST', headers: { 'content-type': soft.type ?? 'application/json', ...signature(provider, soft.body).headers }, body: soft.body })).status).toBe(200);
      expect((await ctx.store.getSubscriberByEmail(email))?.status).toBe('subscribed');
      const complaint = event(provider, 'complaint');
      expect((await originalFetch(base + path, { method: 'POST', headers: { 'content-type': complaint.type ?? 'application/json', ...signature(provider, complaint.body).headers }, body: complaint.body })).status).toBe(200);
      expect((await ctx.store.getSubscriberByEmail(email))?.status).toBe('unsubscribed');
    }));
  });
}

it('acknowledges a signed unknown event without changing the subscriber', async () => withServer(async (base, ctx) => {
  const body = JSON.stringify({ type: 'delivered', email });
  const response = await originalFetch(base + '/api/webhooks/generic', { method: 'POST', headers: { 'content-type': 'application/json', ...signature('generic', body).headers }, body });
  expect(response.status).toBe(200);
  expect((await ctx.store.getSubscriberByEmail(email))?.status).toBe('subscribed');
}));

it('SES verifies SNS RSA signature, ignores transient bounces, and never follows confirmation URLs', async () => withServer(async (base, ctx) => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => String(input).endsWith('.pem') ? new Response(pem) : originalFetch(input, init)) as typeof fetch;
  const path = base + '/api/webhooks/ses';
  const make = (type: 'Notification' | 'SubscriptionConfirmation', message: object) => {
    const payload: Record<string, string> = { Type: type, MessageId: 'sns_1', TopicArn: topic, Message: JSON.stringify(message), Timestamp: new Date().toISOString(), SignatureVersion: '2', SigningCertURL: 'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-test.pem' };
    if (type === 'SubscriptionConfirmation') { payload.SubscribeURL = 'https://evil.example/confirm'; payload.Token = 'token'; }
    const fields = type === 'Notification' ? ['Message', 'MessageId', 'Timestamp', 'TopicArn', 'Type'] : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];
    payload.Signature = sign('sha256', Buffer.from(fields.map((field) => `${field}\n${payload[field]}\n`).join('')), rsa.privateKey).toString('base64');
    return JSON.stringify(payload);
  };
  const badBody = make('Notification', { notificationType: 'Bounce', bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: email }] } });
  const badPayload = JSON.parse(badBody); badPayload.Signature = 'bad';
  expect((await originalFetch(path, { method: 'POST', body: JSON.stringify(badPayload), headers: { 'content-type': 'text/plain' } })).status).toBe(401);
  const confirm = make('SubscriptionConfirmation', {});
  expect((await originalFetch(path, { method: 'POST', body: confirm, headers: { 'content-type': 'text/plain' } })).status).toBe(200);
  expect((await ctx.store.getSubscriberByEmail(email))?.status).toBe('subscribed');
  const soft = make('Notification', { notificationType: 'Bounce', bounce: { bounceType: 'Transient', bouncedRecipients: [{ emailAddress: email }] } });
  expect((await originalFetch(path, { method: 'POST', body: soft, headers: { 'content-type': 'text/plain' } })).status).toBe(200);
  expect((await ctx.store.getSubscriberByEmail(email))?.status).toBe('subscribed');
  expect((await originalFetch(path, { method: 'POST', body: badBody, headers: { 'content-type': 'text/plain' } })).status).toBe(200);
  expect((await ctx.store.getSubscriberByEmail(email))?.status).toBe('bounced');
  const complaint = make('Notification', { notificationType: 'Complaint', complaint: { complainedRecipients: [{ emailAddress: email }] } });
  expect((await originalFetch(path, { method: 'POST', body: complaint, headers: { 'content-type': 'text/plain' } })).status).toBe(200);
  expect((await ctx.store.getSubscriberByEmail(email))?.status).toBe('unsubscribed');
}));

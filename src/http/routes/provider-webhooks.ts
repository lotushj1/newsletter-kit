import { createHmac, createPublicKey, timingSafeEqual, verify as verifySignature } from 'node:crypto';
import { Router, type Request } from 'express';
import type { ServiceContext } from '../../services/context.js';
import { applyProviderProblem, type SuppressionReason } from '../../services/suppression.js';
import { asyncRoute } from '../helpers.js';

interface Problem { email?: string; providerMessageId?: string; reason: SuppressionReason }
type Row = Record<string, unknown>;

function object(value: unknown): Row { return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}; }
function string(value: unknown): string { return typeof value === 'string' ? value : ''; }
function equal(a: string, b: string): boolean {
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function hmac(algorithm: string, key: string | Buffer, data: string, encoding: 'hex' | 'base64'): string {
  return createHmac(algorithm, key).update(data).digest(encoding);
}
function raw(req: Request): string { return Buffer.isBuffer(req.body) ? req.body.toString('utf8') : ''; }
function json(body: string): Row { try { return object(JSON.parse(body)); } catch { return {}; } }
function addresses(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(addresses);
  const email = string(value).trim().toLowerCase();
  return email.includes('@') ? [email] : [];
}
function oneEmail(value: unknown): string | undefined { return addresses(value)[0]; }
function authSecret(req: Request, secret: string): boolean {
  const authorization = string(req.headers.authorization);
  const token = string(req.headers['x-webhook-token']);
  if (token && equal(token, secret)) return true;
  if (authorization.startsWith('Bearer ') && equal(authorization.slice(7), secret)) return true;
  if (authorization.startsWith('Basic ')) {
    try { return equal(Buffer.from(authorization.slice(6), 'base64').toString('utf8').split(':').slice(1).join(':'), secret); } catch { return false; }
  }
  return false;
}

function svix(req: Request, secret: string, body: string): boolean {
  const id = string(req.headers['svix-id']);
  const timestamp = string(req.headers['svix-timestamp']);
  const signature = string(req.headers['svix-signature']);
  if (!id || !timestamp || !signature || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  try {
    const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
    const expected = hmac('sha256', key, `${id}.${timestamp}.${body}`, 'base64');
    return signature.split(' ').some((part) => part.startsWith('v1,') && equal(part.slice(3), expected));
  } catch { return false; }
}

function sendgrid(req: Request, publicKey: string, body: string): boolean {
  const timestamp = string(req.headers['x-twilio-email-event-webhook-timestamp']);
  const signature = string(req.headers['x-twilio-email-event-webhook-signature']);
  if (!timestamp || !signature || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  try {
    const der = publicKey.includes('BEGIN PUBLIC KEY') ? publicKey : (() => {
      const point = Buffer.from(publicKey, 'base64');
      return Buffer.concat([Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex'), point]);
    })();
    const key = createPublicKey(typeof der === 'string' ? der : { key: der, format: 'der', type: 'spki' });
    return verifySignature('sha256', Buffer.from(timestamp + body), key, Buffer.from(signature, 'base64'));
  } catch { return false; }
}

function mailgun(req: Request, secret: string, payload: Row): boolean {
  const signing = object(payload.signature);
  const timestamp = string(signing.timestamp);
  const token = string(signing.token);
  const signature = string(signing.signature);
  return Boolean(timestamp && token && signature && Math.abs(Date.now() / 1000 - Number(timestamp)) <= 300 &&
    equal(hmac('sha256', secret, timestamp + token, 'hex'), signature));
}

function mandrill(req: Request, secret: string, body: string, url: string): boolean {
  const params = new URLSearchParams(body);
  const values = [...params.keys()].sort().map((key) => key + (params.get(key) ?? '')).join('');
  return equal(hmac('sha1', secret, url + values, 'base64'), string(req.headers['x-mandrill-signature']));
}

const SNS_FIELDS = ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'] as const;
const SNS_CONFIRM_FIELDS = ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'] as const;
async function sns(req: Request, payload: Row, topicArn: string): Promise<boolean> {
  if (payload.TopicArn !== topicArn || !['Notification', 'SubscriptionConfirmation'].includes(string(payload.Type))) return false;
  const certUrl = string(payload.SigningCertURL);
  try {
    const url = new URL(certUrl);
    const region = topicArn.split(':')[3];
    if (url.protocol !== 'https:' || url.port || url.hostname !== `sns.${region}.amazonaws.com` || !/^\/SimpleNotificationService-[a-zA-Z0-9]+\.pem$/.test(url.pathname)) return false;
    const response = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'error' });
    if (!response.ok) return false;
    const certificate = await response.text();
    const fields = string(payload.Type) === 'Notification' ? SNS_FIELDS : SNS_CONFIRM_FIELDS;
    const canonical = fields.filter((field) => payload[field] !== undefined).map((field) => `${field}\n${string(payload[field])}\n`).join('');
    const algorithm = payload.SignatureVersion === '2' ? 'sha256' : payload.SignatureVersion === '1' ? 'sha1' : '';
    return Boolean(algorithm && verifySignature(algorithm, Buffer.from(canonical), certificate, Buffer.from(string(payload.Signature), 'base64')));
  } catch { return false; }
}

function parse(provider: string, payload: Row, body: string): Problem[] {
  if (provider === 'resend') {
    const event = string(payload.type);
    if (!['email.bounced', 'email.suppressed', 'email.complained'].includes(event)) return [];
    const data = object(payload.data);
    return addresses(data.to ?? data.email).map((email) => ({ email, providerMessageId: string(data.email_id || data.id), reason: event === 'email.complained' ? 'complaint' : 'bounce' }));
  }
  if (provider === 'ses') {
    const notice = json(string(payload.Message));
    const notification = string(notice.notificationType);
    if (notification === 'Bounce' && object(notice.bounce).bounceType === 'Permanent') {
      return (Array.isArray(object(notice.bounce).bouncedRecipients) ? object(notice.bounce).bouncedRecipients as unknown[] : [])
        .map((item) => ({ email: oneEmail(object(item).emailAddress), providerMessageId: string(object(notice.mail).messageId), reason: 'bounce' as const }));
    }
    if (notification === 'Complaint') {
      return (Array.isArray(object(notice.complaint).complainedRecipients) ? object(notice.complaint).complainedRecipients as unknown[] : [])
        .map((item) => ({ email: oneEmail(object(item).emailAddress), providerMessageId: string(object(notice.mail).messageId), reason: 'complaint' as const }));
    }
    return [];
  }
  if (provider === 'postmark') {
    const type = string(payload.Type || payload.RecordType);
    if (type !== 'HardBounce' && type !== 'SpamComplaint') return [];
    return [{ email: oneEmail(payload.Email), providerMessageId: string(payload.MessageID), reason: type === 'SpamComplaint' ? 'complaint' : 'bounce' }];
  }
  if (provider === 'sendgrid') {
    const items = Array.isArray(JSON.parse(body)) ? JSON.parse(body) as unknown[] : [];
    return items.flatMap((item) => {
      const row = object(item); const event = string(row.event);
      if (!['bounce', 'dropped', 'spamreport'].includes(event)) return [];
      return [{ email: oneEmail(row.email), providerMessageId: string(row.sg_message_id), reason: event === 'spamreport' ? 'complaint' as const : 'bounce' as const }];
    });
  }
  if (provider === 'mailgun') {
    const event = object(payload['event-data']);
    const kind = string(event.event);
    if (kind === 'complained') return [{ email: oneEmail(event.recipient), reason: 'complaint' }];
    if (kind === 'failed' && object(event['delivery-status']).severity === 'permanent') return [{ email: oneEmail(event.recipient), reason: 'bounce' }];
    return [];
  }
  if (provider === 'brevo') {
    const event = string(payload.event).toLowerCase();
    if (['hard_bounce', 'blocked'].includes(event)) return [{ email: oneEmail(payload.email), reason: 'bounce' }];
    if (['spam', 'complaint'].includes(event)) return [{ email: oneEmail(payload.email), reason: 'complaint' }];
    return [];
  }
  if (provider === 'mailchimp') {
    const events = JSON.parse(new URLSearchParams(body).get('mandrill_events') ?? '[]') as unknown[];
    return (Array.isArray(events) ? events : []).flatMap((item) => {
      const row = object(item); const event = string(row.event);
      if (!['hard_bounce', 'reject', 'spam'].includes(event)) return [];
      return [{ email: oneEmail(object(row.msg).email), reason: event === 'spam' ? 'complaint' as const : 'bounce' as const }];
    });
  }
  if (provider === 'generic') {
    const kind = string(payload.type || payload.event);
    if (!['bounce', 'hard_bounce', 'complaint'].includes(kind)) return [];
    return [{ email: oneEmail(payload.email), providerMessageId: string(payload.providerMessageId), reason: kind === 'complaint' ? 'complaint' : 'bounce' }];
  }
  if (provider === 'mailersend') {
    const kind = string(payload.type);
    const data = object(payload.data);
    if (kind === 'activity.hard_bounced') return [{ email: oneEmail(data.recipient), providerMessageId: string(data.message_id), reason: 'bounce' }];
    if (kind === 'activity.spam_complaint') return [{ email: oneEmail(data.recipient), providerMessageId: string(data.message_id), reason: 'complaint' }];
    if (kind === 'activity.suppressed') {
      const reason = string(object(data.meta).suppression_reason);
      if (reason === 'hard_bounced') return [{ email: oneEmail(data.recipient), reason: 'bounce' }];
      if (reason === 'spam_complained') return [{ email: oneEmail(data.recipient), reason: 'complaint' }];
    }
    return [];
  }
  if (provider === 'sparkpost') {
    const items = JSON.parse(body) as unknown;
    return (Array.isArray(items) ? items : []).flatMap<Problem>((item) => {
      const event = object(object(item).msys).message_event;
      const row = object(event); const kind = string(row.type);
      if (kind === 'spam_complaint') return [{ email: oneEmail(row.rcpt_to), reason: 'complaint' as const }];
      if (['bounce', 'out_of_band'].includes(kind) && [10, 30, 90].includes(Number(row.bounce_class))) return [{ email: oneEmail(row.rcpt_to), reason: 'bounce' as const }];
      return [];
    });
  }
  if (provider === 'smtp2go') {
    const row = body.startsWith('{') ? payload : Object.fromEntries(new URLSearchParams(body));
    const kind = string(row.event);
    if (kind === 'spam') return [{ email: oneEmail(row.rcpt), reason: 'complaint' }];
    if (kind === 'bounce' && row.bounce === 'hard') return [{ email: oneEmail(row.rcpt), reason: 'bounce' }];
    return [];
  }
  if (provider === 'plunk') {
    const event = object(payload.event);
    const contact = object(payload.contact);
    const email = oneEmail(contact.email);
    const providerMessageId = string(event.emailId);
    if (event.bounceType === 'Permanent') return [{ email, providerMessageId, reason: 'bounce' }];
    if (event.complainedAt) return [{ email, providerMessageId, reason: 'complaint' }];
    return [];
  }
  return [];
}

export function providerWebhookRouter(ctx: ServiceContext): Router {
  const router = Router();
  router.get('/elasticemail', asyncRoute(async (req, res) => {
    const secret = ctx.config.webhookSecrets.elasticemail;
    if (!secret) { res.status(503).json({ error: 'Webhook 尚未設定' }); return; }
    const params = new URL(req.url, 'http://localhost').searchParams;
    if (!equal(params.get('token') ?? '', secret)) { res.status(401).json({ error: '簽章無效' }); return; }
    const status = (params.get('status') ?? '').toLowerCase();
    const category = (params.get('category') ?? '').toLowerCase();
    const reason: SuppressionReason | undefined = status === 'abusereport' ? 'complaint'
      : status === 'error' && ['nomailbox', 'blacklisted'].includes(category) ? 'bounce' : undefined;
    if (reason) await applyProviderProblem(ctx, {
      provider: 'elasticemail', email: oneEmail(params.get('to')), providerMessageId: params.get('messageid') ?? undefined, reason,
    });
    res.json({ ok: true, processed: reason ? 1 : 0 });
  }));
  for (const provider of ['resend', 'ses', 'postmark', 'sendgrid', 'mailgun', 'brevo', 'mailchimp', 'mailersend', 'sparkpost', 'smtp2go', 'plunk', 'generic']) {
    router.post(`/${provider}`, asyncRoute(async (req, res) => {
      const body = raw(req);
      const payload = provider === 'mailchimp' ? {} : json(body);
      const secret = ctx.config.webhookSecrets[provider === 'ses' ? 'sesTopicArn' : provider];
      if (!secret) { res.status(503).json({ error: 'Webhook 尚未設定' }); return; }
      let verified = false;
      if (provider === 'resend') verified = svix(req, secret, body);
      else if (provider === 'ses') verified = await sns(req, payload, secret);
      else if (provider === 'postmark' || provider === 'brevo' || provider === 'plunk') verified = authSecret(req, secret);
      else if (provider === 'sendgrid') verified = sendgrid(req, secret, body);
      else if (provider === 'mailgun') verified = mailgun(req, secret, payload);
      else if (provider === 'mailchimp') verified = mandrill(req, secret, body, `${ctx.config.publicBaseUrl}/api/webhooks/mailchimp`);
      else if (provider === 'mailersend') verified = equal(string(req.headers.signature), hmac('sha256', secret, body, 'hex'));
      else if (provider === 'sparkpost') verified = equal(string(req.headers['x-messagesystems-webhook-token']), secret) || authSecret(req, secret);
      else if (provider === 'smtp2go') verified = authSecret(req, secret);
      else verified = equal(string(req.headers['x-newsletter-signature']), `sha256=${hmac('sha256', secret, body, 'hex')}`);
      if (!verified) { res.status(401).json({ error: '簽章無效' }); return; }
      if (provider === 'ses' && payload.Type === 'SubscriptionConfirmation') {
        // Confirmation is intentionally manual. Never follow an untrusted URL from a POST.
        res.json({ ok: true, confirmationRequired: true }); return;
      }
      let problems: Problem[] = [];
      try { problems = parse(provider, payload, body); } catch { /* unknown or malformed event is acknowledged */ }
      for (const problem of problems) await applyProviderProblem(ctx, { ...problem, provider });
      res.json({ ok: true, processed: problems.length });
    }));
  }
  return router;
}

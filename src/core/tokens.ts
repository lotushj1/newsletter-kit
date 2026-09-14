import { createHmac, timingSafeEqual } from 'node:crypto';

export type TokenPurpose = 'confirm' | 'unsubscribe' | 'open' | 'click';

interface TokenPayload {
  /** email */
  e: string;
  /** purpose */
  p: TokenPurpose;
  /** issued at (seconds) */
  t: number;
  /** campaign id */
  c?: string;
  /** delivery id */
  d?: string;
  /** subscriber id */
  s?: string;
  /** click destination */
  u?: string;
}

const b64u = (buf: Buffer): string => buf.toString('base64url');

function sign(secret: string, body: string): string {
  return b64u(createHmac('sha256', secret).update(body).digest());
}

function signBody(secret: string, body: string): string {
  return `${body}.${sign(secret, body)}`;
}

/**
 * 無狀態簽章 token：確認信與退訂連結都用它，不必另建 token 表。
 * 換掉 APP_SECRET 會讓所有已寄出的連結失效。
 */
export function createToken(
  secret: string,
  purpose: TokenPurpose,
  email: string,
  extra?: { campaignId?: string; deliveryId?: string; subscriberId?: string },
): string {
  const payload: TokenPayload = {
    e: email.toLowerCase(),
    p: purpose,
    t: Math.floor(Date.now() / 1000),
    c: extra?.campaignId,
    d: extra?.deliveryId,
    s: extra?.subscriberId,
  };
  const body = b64u(Buffer.from(JSON.stringify(payload), 'utf8'));
  return signBody(secret, body);
}

export interface TrackingTokenInput {
  purpose: 'open' | 'click';
  email: string;
  campaignId: string;
  deliveryId: string;
  subscriberId: string;
  url?: string;
}

export function createTrackingToken(secret: string, input: TrackingTokenInput): string {
  const payload: TokenPayload = {
    e: input.email.toLowerCase(),
    p: input.purpose,
    t: Math.floor(Date.now() / 1000),
    c: input.campaignId,
    d: input.deliveryId,
    s: input.subscriberId,
  };
  if (input.url) payload.u = input.url;
  const body = b64u(Buffer.from(JSON.stringify(payload), 'utf8'));
  return signBody(secret, body);
}

export interface VerifiedToken {
  email: string;
  purpose: TokenPurpose;
  issuedAt: Date;
  campaignId?: string;
  deliveryId?: string;
  subscriberId?: string;
  url?: string;
}

/** maxAgeSeconds 傳 undefined 代表永不過期（退訂連結就該永久有效）。 */
export function verifyToken(
  secret: string,
  token: string,
  purpose: TokenPurpose,
  maxAgeSeconds?: number,
): VerifiedToken | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const provided = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(secret, body));
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;

  let payload: TokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenPayload;
  } catch {
    return null;
  }
  if (payload.p !== purpose || typeof payload.e !== 'string' || typeof payload.t !== 'number') {
    return null;
  }
  if (maxAgeSeconds !== undefined && Date.now() / 1000 - payload.t > maxAgeSeconds) return null;
  return {
    email: payload.e,
    purpose: payload.p,
    issuedAt: new Date(payload.t * 1000),
    campaignId: payload.c,
    deliveryId: payload.d,
    subscriberId: payload.s,
    url: payload.u,
  };
}

export function hmacSha256Hex(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

export function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

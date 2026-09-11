import { createHmac, timingSafeEqual } from 'node:crypto';

export type TokenPurpose = 'confirm' | 'unsubscribe';

interface TokenPayload {
  /** email */
  e: string;
  /** purpose */
  p: TokenPurpose;
  /** issued at (seconds) */
  t: number;
}

const b64u = (buf: Buffer): string => buf.toString('base64url');

function sign(secret: string, body: string): string {
  return b64u(createHmac('sha256', secret).update(body).digest());
}

/**
 * 無狀態簽章 token：確認信與退訂連結都用它，不必另建 token 表。
 * 換掉 APP_SECRET 會讓所有已寄出的連結失效。
 */
export function createToken(secret: string, purpose: TokenPurpose, email: string): string {
  const payload: TokenPayload = { e: email.toLowerCase(), p: purpose, t: Math.floor(Date.now() / 1000) };
  const body = b64u(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${body}.${sign(secret, body)}`;
}

export interface VerifiedToken {
  email: string;
  purpose: TokenPurpose;
  issuedAt: Date;
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
  return { email: payload.e, purpose: payload.p, issuedAt: new Date(payload.t * 1000) };
}

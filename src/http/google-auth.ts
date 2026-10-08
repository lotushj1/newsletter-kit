import { createHash, createPublicKey, randomBytes, verify as verifySignature } from 'node:crypto';
import type { JsonWebKey as NodeJsonWebKey } from 'node:crypto';
import type { Request, Response as ExpressResponse } from 'express';
import type { Config } from '../config.js';
import { isGoogleConfigured, isGoogleEmailAllowed, readCookie, sanitizeAdminNext, signValue, verifySignedValue } from './auth.js';

const FLOW_COOKIE = 'nk_google_flow';
const FLOW_AGE_SECONDS = 60 * 10;
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const JWKS_ENDPOINT = 'https://www.googleapis.com/oauth2/v3/certs';
const ID_TOKEN_ERROR = 'Google 身分驗證失敗，請重新登入。';
const FLOW_ERROR = '登入流程已過期或無效，請重新登入。';

type JsonRecord = Record<string, unknown>;

interface LoginFlow {
  kind: 'google-flow';
  state: string;
  codeVerifier: string;
  nonce: string;
  next: string;
  issuedAt: number;
  expiresAt: number;
}

export class GoogleLoginError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

function record(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function flowFromCookie(config: Config, value: string | undefined): LoginFlow | null {
  if (!value) return null;
  const payload = verifySignedValue(config.appSecret, value);
  if (!record(payload) || payload.kind !== 'google-flow' ||
      typeof payload.state !== 'string' || typeof payload.codeVerifier !== 'string' ||
      typeof payload.nonce !== 'string' || typeof payload.next !== 'string' ||
      typeof payload.issuedAt !== 'number' || typeof payload.expiresAt !== 'number') return null;
  const now = Math.floor(Date.now() / 1000);
  if (!/^[A-Za-z0-9_-]{43}$/.test(payload.state) ||
      !/^[A-Za-z0-9_-]{43}$/.test(payload.codeVerifier) ||
      !/^[A-Za-z0-9_-]{43}$/.test(payload.nonce) ||
      payload.issuedAt > now + 60 || payload.expiresAt <= now ||
      payload.expiresAt - payload.issuedAt !== FLOW_AGE_SECONDS ||
      sanitizeAdminNext(payload.next) !== payload.next) return null;
  return payload as unknown as LoginFlow;
}

function clearFlowCookie(res: ExpressResponse, secure: boolean): void {
  const parts = [`${FLOW_COOKIE}=`, 'Path=/admin/auth', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

function parseJsonPart(value: string): JsonRecord | null {
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    return record(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

export function createGoogleOAuth(config: Config, fetcher: typeof fetch = fetch) {
  let jwks: JsonRecord[] = [];
  let jwksExpiresAt = 0;
  const secure = config.publicBaseUrl.startsWith('https://');

  async function getGoogleKey(kid: string) {
    let jwk = Date.now() < jwksExpiresAt ? jwks.find((key) => key.kid === kid) : undefined;
    if (!jwk) {
      let response: Response;
      try {
        response = await fetcher(JWKS_ENDPOINT);
      } catch {
        throw new GoogleLoginError(502, '無法向 Google 驗證身分，請稍後重試。');
      }
      if (!response.ok) throw new GoogleLoginError(502, '無法向 Google 驗證身分，請稍後重試。');
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new GoogleLoginError(502, 'Google 驗證資料無效，請稍後重試。');
      }
      if (!record(body) || !Array.isArray(body.keys)) {
        throw new GoogleLoginError(502, 'Google 驗證資料無效，請稍後重試。');
      }
      jwks = body.keys.filter(record);
      jwksExpiresAt = Date.now() + 5 * 60 * 1000;
      jwk = jwks.find((key) => key.kid === kid);
    }
    if (!jwk || jwk.kty !== 'RSA' || (jwk.alg !== undefined && jwk.alg !== 'RS256') ||
        jwk.use !== undefined && jwk.use !== 'sig') throw new GoogleLoginError(401, ID_TOKEN_ERROR);
    try {
      return createPublicKey({ key: jwk as NodeJsonWebKey, format: 'jwk' });
    } catch {
      throw new GoogleLoginError(401, ID_TOKEN_ERROR);
    }
  }

  async function verifyIdToken(idToken: string, nonce: string): Promise<string> {
    if (idToken.length > 20_000) throw new GoogleLoginError(401, ID_TOKEN_ERROR);
    const parts = idToken.split('.');
    if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
      throw new GoogleLoginError(401, ID_TOKEN_ERROR);
    }
    const header = parseJsonPart(parts[0]);
    const claims = parseJsonPart(parts[1]);
    if (!header || !claims || header.alg !== 'RS256' || typeof header.kid !== 'string') {
      throw new GoogleLoginError(401, ID_TOKEN_ERROR);
    }
    const key = await getGoogleKey(header.kid);
    const verified = verifySignature(
      'RSA-SHA256',
      Buffer.from(`${parts[0]}.${parts[1]}`),
      key,
      Buffer.from(parts[2], 'base64url'),
    );
    if (!verified) throw new GoogleLoginError(401, ID_TOKEN_ERROR);
    const now = Math.floor(Date.now() / 1000);
    if ((claims.iss !== 'https://accounts.google.com' && claims.iss !== 'accounts.google.com') ||
        claims.aud !== config.google.clientId ||
        !Number.isSafeInteger(claims.exp) || (claims.exp as number) <= now ||
        !Number.isSafeInteger(claims.iat) || (claims.iat as number) > now + 60 ||
        (claims.iat as number) < now - 600 || (claims.iat as number) >= (claims.exp as number) ||
        claims.nonce !== nonce || typeof claims.email !== 'string' || !claims.email.trim()) {
      throw new GoogleLoginError(401, ID_TOKEN_ERROR);
    }
    const email = claims.email.trim().toLowerCase();
    if (claims.email_verified !== true) {
      throw new GoogleLoginError(403, '這個 Google 帳號的 email 尚未驗證。');
    }
    if (!isGoogleEmailAllowed(config, email)) {
      throw new GoogleLoginError(403, `這個 Google 帳號（${email}）沒有後台權限。`);
    }
    return email;
  }

  return {
    begin(res: ExpressResponse, next: string): string {
      const now = Math.floor(Date.now() / 1000);
      const flow: LoginFlow = {
        kind: 'google-flow',
        state: randomBytes(32).toString('base64url'),
        codeVerifier: randomBytes(32).toString('base64url'),
        nonce: randomBytes(32).toString('base64url'),
        next: sanitizeAdminNext(next),
        issuedAt: now,
        expiresAt: now + FLOW_AGE_SECONDS,
      };
      const parts = [
        `${FLOW_COOKIE}=${encodeURIComponent(signValue(config.appSecret, flow as unknown as JsonRecord))}`,
        'Path=/admin/auth',
        'HttpOnly',
        'SameSite=Lax',
        `Max-Age=${FLOW_AGE_SECONDS}`,
      ];
      if (secure) parts.push('Secure');
      res.append('Set-Cookie', parts.join('; '));
      const url = new URL(AUTH_ENDPOINT);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', 'openid email');
      url.searchParams.set('client_id', config.google.clientId!);
      url.searchParams.set('redirect_uri', config.google.redirectUri);
      url.searchParams.set('state', flow.state);
      url.searchParams.set('code_challenge', createHash('sha256').update(flow.codeVerifier).digest('base64url'));
      url.searchParams.set('code_challenge_method', 'S256');
      url.searchParams.set('nonce', flow.nonce);
      url.searchParams.set('prompt', 'select_account');
      if (config.google.adminEmails.length === 1) url.searchParams.set('login_hint', config.google.adminEmails[0]!);
      return url.toString();
    },

    async finish(req: Request, res: ExpressResponse): Promise<{ email: string; next: string }> {
      clearFlowCookie(res, secure);
      if (!isGoogleConfigured(config)) throw new GoogleLoginError(404, 'Google 登入目前未啟用。');
      const flow = flowFromCookie(config, readCookie(req, FLOW_COOKIE));
      if (req.query.error !== undefined) {
        throw new GoogleLoginError(400, 'Google 登入已取消或失敗，請重新登入。');
      }
      if (!flow || typeof req.query.state !== 'string' || req.query.state !== flow.state ||
          typeof req.query.code !== 'string' || !req.query.code) {
        throw new GoogleLoginError(400, FLOW_ERROR);
      }
      let response: Response;
      try {
        response = await fetcher(TOKEN_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: req.query.code,
            client_id: config.google.clientId!,
            client_secret: config.google.clientSecret!,
            redirect_uri: config.google.redirectUri,
            code_verifier: flow.codeVerifier,
          }),
        });
      } catch {
        throw new GoogleLoginError(502, '無法完成 Google 登入，請稍後重試。');
      }
      if (!response.ok) throw new GoogleLoginError(400, 'Google 登入流程已過期或無效，請重新登入。');
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new GoogleLoginError(502, 'Google 登入回應無效，請稍後重試。');
      }
      if (!record(body) || typeof body.id_token !== 'string') {
        throw new GoogleLoginError(502, 'Google 登入回應無效，請稍後重試。');
      }
      return { email: await verifyIdToken(body.id_token, flow.nonce), next: flow.next };
    },
  };
}

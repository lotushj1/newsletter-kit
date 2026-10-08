import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import type { Express } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, type Config } from '../src/config.js';
import { createApp } from '../src/http/app.js';
import type { ServiceContext } from '../src/services/context.js';
import { makeContext } from './helpers.js';

const CLIENT_ID = 'newsletter-admin.apps.googleusercontent.com';
// 測試用的假值，每次執行隨機產生，不在原始碼裡寫死。
const FAKE_CLIENT_SECRET = randomBytes(16).toString('hex');
const CALLBACK = 'https://newsletter.test/admin/auth/google/callback';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const JWKS_ENDPOINT = 'https://www.googleapis.com/oauth2/v3/certs';
const ADMIN_EMAIL = 'admin@example.com';
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const { privateKey: otherPrivateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };
const apps = new Map<string, Express>();
let nextAppId = 0;

/** Express request injection avoids opening a network socket in restricted runtimes. */
async function fetch(input: string, init: RequestInit = {}): Promise<Response> {
  const url = new URL(input);
  const app = apps.get(url.origin);
  if (!app) throw new Error(`No test app for ${url.origin}`);
  const body = init.body instanceof URLSearchParams ? init.body.toString() :
    typeof init.body === 'string' ? init.body : undefined;
  const headers = new Headers(init.headers);
  headers.set('host', url.host);
  if (body !== undefined) headers.set('content-length', String(Buffer.byteLength(body)));
  const req = new IncomingMessage(new Socket());
  req.method = init.method ?? 'GET';
  req.url = `${url.pathname}${url.search}`;
  req.headers = Object.fromEntries(headers.entries());
  if (body !== undefined) req.push(Buffer.from(body));
  req.push(null);
  return new Promise<Response>((resolve, reject) => {
    const res = new ServerResponse(req);
    const chunks: Buffer[] = [];
    res.write = ((chunk: string | Uint8Array) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return true;
    }) as typeof res.write;
    res.end = ((chunk?: string | Uint8Array) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(res.getHeaders())) {
        if (Array.isArray(value)) value.forEach((item) => responseHeaders.append(key, String(item)));
        else if (value !== undefined) responseHeaders.set(key, String(value));
      }
      resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: responseHeaders }));
      return res;
    }) as typeof res.end;
    try {
      app(req as Parameters<Express>[0], res as Parameters<Express>[1], reject);
    } catch (error) {
      reject(error);
    }
  });
}

interface IdClaims {
  iss: string;
  aud: string;
  exp: number;
  iat: number;
  nonce: string;
  email: string;
  email_verified: boolean;
}

interface FakeGoogle {
  nonce: string;
  claims: Partial<IdClaims>;
  badSignature: boolean;
  tokenRequests: URLSearchParams[];
  jwksRequests: number;
}

interface Harness {
  base: string;
  ctx: ServiceContext;
  google: FakeGoogle;
}

function googleConfig(adminEmails = [ADMIN_EMAIL]): Config['google'] {
  return {
    clientId: CLIENT_ID,
    clientSecret: FAKE_CLIENT_SECRET,
    adminEmails,
    redirectUri: CALLBACK,
  };
}

function idToken(google: FakeGoogle): string {
  const now = Math.floor(Date.now() / 1000);
  const claims: IdClaims = {
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    exp: now + 300,
    iat: now,
    nonce: google.nonce,
    email: ADMIN_EMAIL,
    email_verified: true,
    ...google.claims,
  };
  const header = { alg: 'RS256', typ: 'JWT', kid: 'test-key' };
  const input = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
  const signature = sign('RSA-SHA256', Buffer.from(input), google.badSignature ? otherPrivateKey : privateKey);
  return `${input}.${signature.toString('base64url')}`;
}

async function makeHarness(config: Config['google'] = googleConfig()): Promise<Harness> {
  const { ctx } = await makeContext({ google: config });
  const google: FakeGoogle = {
    nonce: '',
    claims: {},
    badSignature: false,
    tokenRequests: [],
    jwksRequests: 0,
  };
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === TOKEN_ENDPOINT) {
      expect(init?.method).toBe('POST');
      google.tokenRequests.push(new URLSearchParams(init?.body as URLSearchParams));
      return Response.json({ id_token: idToken(google) });
    }
    if (url === JWKS_ENDPOINT) {
      google.jwksRequests++;
      return Response.json({ keys: [jwk] });
    }
    throw new Error(`Unexpected OAuth request: ${url}`);
  }) as typeof globalThis.fetch;
  const base = `http://local-${++nextAppId}.test`;
  apps.set(base, createApp(ctx, { googleFetch: fakeFetch }));
  return { base, ctx, google };
}

afterEach(() => {
  vi.unstubAllEnvs();
  apps.clear();
});

function cookiePair(response: Response, name: string): string | undefined {
  return response.headers.get('set-cookie')?.match(new RegExp(`(?:^|,\\s*)(${name}=[^;]*)`))?.[1];
}

interface LoginStart {
  authUrl: URL;
  flowCookie: string;
  response: Response;
}

async function begin(h: Harness, next = '/admin'): Promise<LoginStart> {
  const response = await fetch(`${h.base}/admin/auth/google?next=${encodeURIComponent(next)}`, {
    redirect: 'manual',
  });
  expect(response.status).toBe(302);
  const authUrl = new URL(response.headers.get('location')!);
  h.google.nonce = authUrl.searchParams.get('nonce')!;
  const flowCookie = cookiePair(response, 'nk_google_flow');
  expect(flowCookie).toBeDefined();
  return { authUrl, flowCookie: flowCookie!, response };
}

async function callback(
  h: Harness,
  start: LoginStart,
  options: { state?: string; cookie?: string | null; error?: string } = {},
): Promise<Response> {
  const params = new URLSearchParams({
    code: 'authorization-code',
    state: options.state ?? start.authUrl.searchParams.get('state')!,
  });
  if (options.error) params.set('error', options.error);
  const cookie = options.cookie === undefined ? start.flowCookie : options.cookie;
  return fetch(`${h.base}/admin/auth/google/callback?${params}`, {
    headers: cookie === null ? {} : { cookie },
    redirect: 'manual',
  });
}

describe('Google 後台登入', () => {
  it('允許名單內已驗證帳號登入，簽名 session cookie 可讀後台 API', async () => {
    const h = await makeHarness();
    h.google.claims.email = 'Admin@Example.COM';
    const page = await (await fetch(`${h.base}/admin/login`)).text();
    expect(page).toContain('用 Google 登入');
    expect(page).toContain('<details');
    expect(page).toContain('用管理密碼登入');

    const start = await begin(h, '/admin/campaigns?sort=recent');
    expect(start.authUrl.origin).toBe('https://accounts.google.com');
    expect(start.authUrl.pathname).toBe('/o/oauth2/v2/auth');
    expect(start.authUrl.searchParams.get('response_type')).toBe('code');
    expect(start.authUrl.searchParams.get('scope')).toBe('openid email');
    expect(start.authUrl.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(start.authUrl.searchParams.get('redirect_uri')).toBe(CALLBACK);
    expect(start.authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(start.authUrl.searchParams.get('prompt')).toBe('select_account');
    expect(start.authUrl.searchParams.get('login_hint')).toBe(ADMIN_EMAIL);
    expect(start.response.headers.get('set-cookie')).toMatch(/Path=\/admin\/auth; HttpOnly; SameSite=Lax; Max-Age=600; Secure/);

    const response = await callback(h, start);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/admin/campaigns?sort=recent');
    expect(response.headers.get('set-cookie')).toContain('nk_google_flow=; Path=/admin/auth');
    const session = cookiePair(response, 'nk_admin');
    expect(session).toBeDefined();
    expect(decodeURIComponent(session!.slice('nk_admin='.length))).toMatch(/^v1\./);
    expect(session).not.toContain(h.ctx.config.adminToken);
    expect(response.headers.get('set-cookie')).toMatch(/nk_admin=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=1209600; Secure/);
    const api = await fetch(`${h.base}/api/admin/session`, { headers: { cookie: session! } });
    expect(api.status).toBe(200);
    expect(h.google.jwksRequests).toBe(1);
  });

  it('名單外帳號會被拒絕，且不會種後台 session', async () => {
    const h = await makeHarness();
    h.google.claims.email = 'outsider@example.com';
    const response = await callback(h, await begin(h));
    expect(response.status).toBe(403);
    expect(await response.text()).toContain('這個 Google 帳號（outsider@example.com）沒有後台權限。');
    expect(cookiePair(response, 'nk_admin')).toBeUndefined();
    expect(response.headers.get('set-cookie')).toContain('nk_google_flow=; Path=/admin/auth');
  });

  it('state 不符、缺少流程 cookie、流程 cookie 被竄改都會拒絕', async () => {
    const h = await makeHarness();
    const start = await begin(h);
    const tampered = `${start.flowCookie.slice(0, -1)}${start.flowCookie.endsWith('a') ? 'b' : 'a'}`;
    for (const options of [{ state: 'wrong-state' }, { cookie: null }, { cookie: tampered }]) {
      const response = await callback(h, start, options);
      expect(response.status).toBe(400);
      expect(await response.text()).toContain('登入流程已過期或無效，請重新登入。');
      expect(cookiePair(response, 'nk_admin')).toBeUndefined();
      expect(response.headers.get('set-cookie')).toContain('nk_google_flow=; Path=/admin/auth');
    }
    expect(h.google.tokenRequests).toHaveLength(0);
  });

  it('token 交換實際送出與授權網址 challenge 對應的 PKCE verifier', async () => {
    const h = await makeHarness();
    const start = await begin(h);
    expect((await callback(h, start)).status).toBe(302);
    expect(h.google.tokenRequests).toHaveLength(1);
    const body = h.google.tokenRequests[0]!;
    const verifier = body.get('code_verifier');
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(createHash('sha256').update(verifier!).digest('base64url'))
      .toBe(start.authUrl.searchParams.get('code_challenge'));
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('authorization-code');
    expect(body.get('redirect_uri')).toBe(CALLBACK);
  });

  it.each([
    ['email 尚未驗證', { email_verified: false }, 403, 'email 尚未驗證'],
    ['aud 錯誤', { aud: 'other-client-id' }, 401, '身分驗證失敗'],
    ['iss 錯誤', { iss: 'https://attacker.example' }, 401, '身分驗證失敗'],
    ['token 已過期', { exp: Math.floor(Date.now() / 1000) - 1 }, 401, '身分驗證失敗'],
    ['nonce 不符', { nonce: 'wrong-nonce' }, 401, '身分驗證失敗'],
  ] as const)('%s 會被拒絕', async (_name, claims, status, message) => {
    const h = await makeHarness();
    h.google.claims = { ...claims };
    const response = await callback(h, await begin(h));
    expect(response.status).toBe(status);
    expect(await response.text()).toContain(message);
    expect(cookiePair(response, 'nk_admin')).toBeUndefined();
    expect(response.headers.get('set-cookie')).toContain('nk_google_flow=; Path=/admin/auth');
  });

  it('簽章與 JWKS 不符會被拒絕', async () => {
    const h = await makeHarness();
    h.google.badSignature = true;
    const response = await callback(h, await begin(h));
    expect(response.status).toBe(401);
    expect(await response.text()).toContain('身分驗證失敗');
    expect(cookiePair(response, 'nk_admin')).toBeUndefined();
  });

  it('Google 回傳 error 時清除流程 cookie 並顯示錯誤', async () => {
    const h = await makeHarness();
    const response = await callback(h, await begin(h), { error: 'access_denied' });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('Google 登入已取消或失敗');
    expect(response.headers.get('set-cookie')).toContain('nk_google_flow=; Path=/admin/auth');
    expect(h.google.tokenRequests).toHaveLength(0);
  });

  it.each([
    ['未設定', { clientId: undefined, clientSecret: undefined, adminEmails: [], redirectUri: CALLBACK }],
    ['只設定 Client ID', { clientId: CLIENT_ID, clientSecret: undefined, adminEmails: [], redirectUri: CALLBACK }],
  ] as const)('Google %s 時維持管理密碼登入', async (_name, google) => {
    const h = await makeHarness({ ...google, adminEmails: [...google.adminEmails] });
    const page = await (await fetch(`${h.base}/admin/login`)).text();
    expect(page).not.toContain('用 Google 登入');
    expect(page).toContain('name="token"');
    expect((await fetch(`${h.base}/admin/auth/google`, { redirect: 'manual' })).status).toBe(404);
    const login = await fetch(`${h.base}/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: h.ctx.config.adminToken, next: '/admin' }),
      redirect: 'manual',
    });
    expect(login.status).toBe(302);
    expect(cookiePair(login, 'nk_admin')).toBeDefined();
  });

  it('設定不完整時 loadConfig 會提出警告並停用 Google 登入', () => {
    vi.stubEnv('GOOGLE_CLIENT_ID', CLIENT_ID);
    vi.stubEnv('GOOGLE_CLIENT_SECRET', '');
    vi.stubEnv('ADMIN_GOOGLE_EMAILS', '');
    const config = loadConfig();
    expect(config.google.clientId).toBe(CLIENT_ID);
    expect(config.google.adminEmails).toEqual([]);
    expect(config.warnings.join(' ')).toContain('Google 後台登入設定不完整');
  });

  it('loadConfig 會正規化允許名單並從 PUBLIC_BASE_URL 推導 callback', () => {
    vi.stubEnv('PUBLIC_BASE_URL', 'https://newsletter.example/');
    vi.stubEnv('GOOGLE_CLIENT_ID', CLIENT_ID);
    vi.stubEnv('GOOGLE_CLIENT_SECRET', FAKE_CLIENT_SECRET);
    vi.stubEnv('ADMIN_GOOGLE_EMAILS', ' Admin@Example.COM , second@example.com, admin@example.com ');
    vi.stubEnv('GOOGLE_REDIRECT_URI', '');
    const config = loadConfig();
    expect(config.google.adminEmails).toEqual(['admin@example.com', 'second@example.com']);
    expect(config.google.redirectUri).toBe('https://newsletter.example/admin/auth/google/callback');
    expect(config.warnings.join(' ')).not.toContain('Google 後台登入設定不完整');
  });

  it('從允許名單移除 email 後，既有 Google session 立刻失效', async () => {
    const h = await makeHarness(googleConfig([ADMIN_EMAIL, 'other@example.com']));
    const login = await callback(h, await begin(h));
    const session = cookiePair(login, 'nk_admin')!;
    const api = () => fetch(`${h.base}/api/admin/session`, { headers: { cookie: session } });
    expect((await api()).status).toBe(200);
    h.ctx.config.google.adminEmails = ['other@example.com'];
    expect((await api()).status).toBe(401);
  });

  it('Bearer ADMIN_TOKEN 仍能進 API，Google session 作為 Bearer 不會通過', async () => {
    const h = await makeHarness();
    const login = await callback(h, await begin(h));
    const session = cookiePair(login, 'nk_admin')!;
    expect((await fetch(`${h.base}/api/admin/session`, {
      headers: { authorization: `Bearer ${h.ctx.config.adminToken}` },
    })).status).toBe(200);
    expect((await fetch(`${h.base}/api/admin/session`, {
      headers: { authorization: `Bearer ${session.slice('nk_admin='.length)}` },
    })).status).toBe(401);
  });

  it('登入 next 不可導向外站，合法內部路徑仍可使用', async () => {
    const h = await makeHarness();
    for (const next of ['https://attacker.example', '//attacker.example', '/\\attacker.example']) {
      const login = await fetch(`${h.base}/admin/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: h.ctx.config.adminToken, next }),
        redirect: 'manual',
      });
      expect(login.status).toBe(302);
      expect(login.headers.get('location')).toBe('/admin');
    }
    const start = await begin(h, '//attacker.example');
    const callbackResponse = await callback(h, start);
    expect(callbackResponse.headers.get('location')).toBe('/admin');
    const valid = await fetch(`${h.base}/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: h.ctx.config.adminToken, next: '/admin/campaigns' }),
      redirect: 'manual',
    });
    expect(valid.headers.get('location')).toBe('/admin/campaigns');
  });

  it('登出會清除 Google session cookie', async () => {
    const h = await makeHarness();
    const login = await callback(h, await begin(h));
    const session = cookiePair(login, 'nk_admin')!;
    const logout = await fetch(`${h.base}/admin/logout`, {
      method: 'POST',
      headers: { cookie: session },
      redirect: 'manual',
    });
    expect(logout.status).toBe(302);
    expect(logout.headers.get('location')).toBe('/admin/login');
    expect(logout.headers.get('set-cookie')).toContain('nk_admin=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  });
});

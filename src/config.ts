import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 極簡 .env 讀取：不覆蓋已存在的環境變數，避免蓋掉部署平台注入的值。
 * 只支援 `KEY=value` 與 `#` 註解，需要進階語法請自己換 dotenv。
 */
export function loadEnvFile(file = '.env'): void {
  const path = resolve(process.cwd(), file);
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key || key in process.env) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

export type StoreDriver = 'sqlite' | 'json' | 'memory' | 'insforge';

export interface Config {
  port: number;
  publicBaseUrl: string;
  siteName: string;
  appSecret: string;
  adminToken: string;
  store: { driver: StoreDriver; path: string };
  uploadsPath: string;
  email: {
    provider: string;
    from: string;
    replyTo: string | undefined;
    webhookUrl: string | undefined;
    webhookSecret: string | undefined;
    resendApiKey: string | undefined;
    zeaburEndpoint: string | undefined;
    zeaburToken: string | undefined;
    insforgeUrl: string | undefined;
    insforgeApiKey: string | undefined;
  };
  doubleOptIn: boolean;
  corsOrigins: string[];
  publicRateLimitPerMin: number;
  trackingEnabled: boolean;
  ingestSecret: string | undefined;
  join: { headline: string | undefined; description: string | undefined; tags: string[] };
  send: { batchSize: number; batchDelayMs: number; maxAttempts: number };
  scheduler: { enabled: boolean; pollMs: number };
  isProduction: boolean;
  warnings: string[];
}

const DEV_SECRET = 'dev-only-insecure-secret';
const DEV_ADMIN_TOKEN = 'dev-admin-token';

function str(key: string, fallback: string): string {
  const raw = process.env[key];
  return raw === undefined || raw === '' ? fallback : raw;
}

function optional(key: string): string | undefined {
  const raw = process.env[key];
  return raw === undefined || raw === '' ? undefined : raw;
}

function num(key: string, fallback: number): number {
  const parsed = Number(process.env[key]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function bool(key: string, fallback: boolean): boolean {
  const raw = optional(key);
  if (raw === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function defaultPublicBaseUrl(port: number): string {
  const host = optional('VERCEL_PROJECT_PRODUCTION_URL') ?? optional('VERCEL_URL');
  if (host) return `https://${host.replace(/^https?:\/\//, '')}`;
  return `http://localhost:${port}`;
}

export function loadConfig(): Config {
  const isProduction = process.env.NODE_ENV === 'production';
  const warnings: string[] = [];

  const appSecret = optional('APP_SECRET') ?? DEV_SECRET;
  const adminToken = optional('ADMIN_TOKEN') ?? DEV_ADMIN_TOKEN;
  if (appSecret === DEV_SECRET) {
    warnings.push('APP_SECRET 未設定，使用開發用預設值。正式環境請務必換掉。');
  }
  if (adminToken === DEV_ADMIN_TOKEN) {
    warnings.push('ADMIN_TOKEN 未設定，後台目前用開發用預設 token。正式環境請務必換掉。');
  }
  if (isProduction && (appSecret === DEV_SECRET || adminToken === DEV_ADMIN_TOKEN)) {
    throw new Error('NODE_ENV=production 時必須設定 APP_SECRET 與 ADMIN_TOKEN。');
  }

  const onVercel = process.env.VERCEL === '1';
  const driver = (optional('STORE_DRIVER') ?? (onVercel ? 'json' : 'sqlite')) as StoreDriver;
  if (!['sqlite', 'json', 'memory', 'insforge'].includes(driver)) {
    throw new Error(`STORE_DRIVER 只能是 sqlite / json / memory / insforge，收到：${driver}`);
  }
  const defaultPath = onVercel
    ? driver === 'memory'
      ? ':memory:'
      : driver === 'json'
        ? '/tmp/newsletter.json'
        : '/tmp/newsletter.db'
    : driver === 'json'
      ? './data/newsletter.json'
      : './data/newsletter.db';

  const port = num('PORT', 4400);
  const corsRaw = str('CORS_ORIGINS', '*');

  return {
    port,
    publicBaseUrl: str('PUBLIC_BASE_URL', defaultPublicBaseUrl(port)).replace(/\/+$/, ''),
    siteName: str('SITE_NAME', 'Newsletter'),
    appSecret,
    adminToken,
    store: { driver, path: str('STORE_PATH', defaultPath) },
    uploadsPath: str('UPLOADS_PATH', onVercel ? '/tmp/newsletter-uploads' : './data/uploads'),
    email: {
      provider: str('EMAIL_PROVIDER', 'dry_run'),
      from: str('MAIL_FROM', 'Newsletter <newsletter@example.com>'),
      replyTo: optional('MAIL_REPLY_TO'),
      webhookUrl: optional('WEBHOOK_URL'),
      webhookSecret: optional('WEBHOOK_SECRET'),
      resendApiKey: optional('RESEND_API_KEY'),
      zeaburEndpoint: optional('ZEABUR_ENDPOINT'),
      zeaburToken: optional('ZEABUR_TOKEN'),
      insforgeUrl: optional('INSFORGE_URL'),
      insforgeApiKey: optional('INSFORGE_API_KEY'),
    },
    doubleOptIn: bool('DOUBLE_OPT_IN', true),
    corsOrigins: corsRaw === '*' ? ['*'] : corsRaw.split(',').map((o) => o.trim()).filter(Boolean),
    publicRateLimitPerMin: num('PUBLIC_RATE_LIMIT_PER_MIN', 20),
    trackingEnabled: bool('TRACKING_ENABLED', true),
    ingestSecret: optional('INGEST_SECRET'),
    join: {
      headline: optional('JOIN_HEADLINE'),
      description: optional('JOIN_DESCRIPTION'),
      tags: str('JOIN_TAGS', '')
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
    },
    send: {
      batchSize: Math.max(1, num('SEND_BATCH_SIZE', 20)),
      batchDelayMs: num('SEND_BATCH_DELAY_MS', 1000),
      maxAttempts: Math.max(1, num('SEND_MAX_ATTEMPTS', 3)),
    },
    scheduler: {
      enabled: bool('SCHEDULER_ENABLED', !onVercel),
      pollMs: Math.max(1000, num('SCHEDULER_POLL_MS', 30_000)),
    },
    isProduction,
    warnings,
  };
}

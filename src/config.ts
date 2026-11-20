import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';
import { getAiService, isKnownAiProvider } from './ai/providers.js';
import { DEFAULT_SITE_NAME } from './store/types.js';

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

export type StoreDriver = 'sqlite' | 'json' | 'memory' | 'insforge' | 'insforge-tables';
export type AiProvider = string;

export interface Config {
  port: number;
  publicBaseUrl: string;
  siteName: string;
  appSecret: string;
  adminToken: string;
  google: {
    clientId: string | undefined;
    clientSecret: string | undefined;
    adminEmails: string[];
    redirectUri: string;
  };
  store: { driver: StoreDriver; path: string };
  uploadsPath: string;
  /** 有值＝不能把上傳圖片存在 uploadsPath（正式環境的暫存目錄）；上傳時回這段說明。 */
  uploadsBlockedReason?: string | undefined;
  email: {
    provider: string;
    from: string;
    replyTo: string | undefined;
    unsubscribeMailto?: string | undefined;
    webhookUrl: string | undefined;
    webhookSecret: string | undefined;
    resendApiKey: string | undefined;
    zeaburEndpoint: string | undefined;
    zeaburToken: string | undefined;
    insforgeUrl: string | undefined;
    insforgeApiKey: string | undefined;
    portalyApiKey: string | undefined;
    portalyApiHost: string | undefined;
    apiKey: string | undefined;
    apiExtra: string | undefined;
    platformSecrets: Record<string, { key?: string | undefined; extra?: string | undefined }>;
  };
  ai: {
    provider: AiProvider;
    apiKey: string | undefined;
    model: string | undefined;
    baseUrl: string | undefined;
  };
  doubleOptIn: boolean;
  /** 這些 source 來的公開訂閱跳過確認信（逗號分隔，SINGLE_OPT_IN_SOURCES）。 */
  singleOptInSources: string[];
  corsOrigins: string[];
  publicRateLimitPerMin: number;
  trackingEnabled: boolean;
  ingestSecret: string | undefined;
  webhookSecrets: Record<string, string | undefined>;
  physicalAddress?: string | undefined;
  privacyUrl?: string | undefined;
  join: { headline: string | undefined; description: string | undefined; tags: string[] };
  send: {
    batchSize: number;
    batchDelayMs: number;
    maxAttempts: number;
    /**
     * 排程器（含外部 cron 打 /api/cron/tick）是否自動接續「寄送中」的電子報。
     * 預設 false：部署、重啟、還原資料後都不會自己恢復寄送，要人工在後台按續寄。
     */
    autoResume?: boolean | undefined;
    /** 單次寄送最多跑多久（毫秒）就先收手；0 = 不限。Vercel 預設 240 秒（函式上限 300 秒）。 */
    timeBudgetMs?: number | undefined;
    /** SEND_PAUSED=true：全面停止寄送（含手動、排程、序列信），只能改環境變數解除。 */
    paused?: boolean | undefined;
  };
  scheduler: { enabled: boolean; pollMs: number; cronSecret: string | undefined };
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

function aiProvider(): AiProvider {
  const raw = str('AI_PROVIDER', 'none');
  if (!isKnownAiProvider(raw)) throw new Error(`AI_PROVIDER 不認識：${raw}`);
  return raw;
}

function defaultAiModel(provider: AiProvider): string | undefined {
  return getAiService(provider)?.defaultModel;
}

function bool(key: string, fallback: boolean): boolean {
  const raw = optional(key);
  if (raw === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

/** 路徑在系統暫存目錄（/tmp、os.tmpdir()）底下：重開機、重新部署或冷啟動後可能消失。 */
export function isTempPath(path: string): boolean {
  if (path === ':memory:') return true;
  const absolute = resolve(path);
  return [...new Set(['/tmp', '/private/tmp', resolve(tmpdir())])].some(
    (dir) => absolute === dir || absolute.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`),
  );
}

/** 正式環境的資料會不會隨時消失；回傳原因，沒問題回 null。 */
function ephemeralStoreProblem(input: {
  explicit: boolean;
  driver: StoreDriver;
  path: string;
  onVercel: boolean;
}): string | null {
  if (!input.explicit) return '沒有設定 STORE_DRIVER';
  if (input.driver === 'memory') return 'STORE_DRIVER=memory 只把資料放在記憶體，重啟就消失';
  if (input.driver === 'sqlite' || input.driver === 'json') {
    if (input.onVercel) return `Vercel 上的 STORE_DRIVER=${input.driver} 只能寫在 /tmp，重新部署或冷啟動就消失`;
    if (isTempPath(input.path)) return `STORE_PATH 在暫存目錄（${input.path}），重開機後可能消失`;
  }
  return null;
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
  // 正式環境（NODE_ENV=production 或 Vercel）：資料一定要放在明確指定、不會消失的地方。
  const hosted = isProduction || onVercel;
  // 試跑用的逃生口：明知資料可能隨時消失，仍要在正式環境用暫存目錄或記憶體。
  const allowEphemeral = bool('ALLOW_EPHEMERAL_STORAGE', false);
  const explicitDriver = optional('STORE_DRIVER');
  const driver = (explicitDriver ?? (onVercel ? 'json' : 'sqlite')) as StoreDriver;
  if (!['sqlite', 'json', 'memory', 'insforge', 'insforge-tables'].includes(driver)) {
    throw new Error(`STORE_DRIVER 只能是 sqlite / json / memory / insforge / insforge-tables，收到：${driver}`);
  }
  const defaultPath = onVercel
    ? driver === 'memory'
      ? ':memory:'
      : driver === 'json'
        ? '/tmp/newsletter.json'
        : '/tmp/newsletter.db'
    : driver === 'memory'
      ? ':memory:'
      : driver === 'json'
        ? './data/newsletter.json'
        : './data/newsletter.db';
  const storePath = str('STORE_PATH', defaultPath);
  if (hosted) {
    const problem = ephemeralStoreProblem({ explicit: Boolean(explicitDriver), driver, path: storePath, onVercel });
    if (problem && !allowEphemeral) {
      throw new Error(
        `正式環境（NODE_ENV=production 或 Vercel）拒絕啟動：${problem}。` +
          '請設定 STORE_DRIVER=insforge-tables（或 insforge）；自架主機可用 STORE_DRIVER=sqlite 並把 STORE_PATH 放在持久磁碟。' +
          '只是試跑、可以接受資料隨時消失，才設 ALLOW_EPHEMERAL_STORAGE=true。',
      );
    }
    if (problem) warnings.push(`ALLOW_EPHEMERAL_STORAGE=true：${problem}，資料可能隨時消失，只適合試跑。`);
  }

  // InsForge 兩種 store 的圖片放 InsForge Storage；其他 driver 才寫本機的 UPLOADS_PATH。
  const uploadsPath = str('UPLOADS_PATH', onVercel ? '/tmp/newsletter-uploads' : './data/uploads');
  let uploadsBlockedReason: string | undefined;
  if (hosted && driver !== 'insforge' && driver !== 'insforge-tables' && (onVercel || isTempPath(uploadsPath))) {
    if (allowEphemeral) {
      warnings.push(`ALLOW_EPHEMERAL_STORAGE=true：上傳的圖片存在暫存目錄（${uploadsPath}），重新部署或重啟後會消失。`);
    } else {
      uploadsBlockedReason =
        `圖片上傳已停用：正式環境不能把圖片存在暫存目錄（${uploadsPath}），重新部署或重啟後圖片會消失。` +
        '請改用 STORE_DRIVER=insforge-tables（圖片存 InsForge Storage），或把 UPLOADS_PATH 設在持久磁碟上。';
      warnings.push(uploadsBlockedReason);
    }
  }

  const port = num('PORT', 4400);
  const publicBaseUrl = str('PUBLIC_BASE_URL', defaultPublicBaseUrl(port)).replace(/\/+$/, '');
  const corsRaw = str('CORS_ORIGINS', '*');
  const provider = aiProvider();
  const googleClientId = optional('GOOGLE_CLIENT_ID')?.trim() || undefined;
  const googleClientSecret = optional('GOOGLE_CLIENT_SECRET')?.trim() || undefined;
  const googleEmails = [...new Set(
    (optional('ADMIN_GOOGLE_EMAILS') ?? '')
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  )];
  const googleParts = [Boolean(googleClientId), Boolean(googleClientSecret), googleEmails.length > 0];
  if (googleParts.some(Boolean) && !googleParts.every(Boolean)) {
    warnings.push('Google 後台登入設定不完整；需同時設定 GOOGLE_CLIENT_ID、GOOGLE_CLIENT_SECRET 與 ADMIN_GOOGLE_EMAILS，已停用 Google 登入。');
  }

  return {
    port,
    publicBaseUrl,
    siteName: str('SITE_NAME', DEFAULT_SITE_NAME),
    appSecret,
    adminToken,
    google: {
      clientId: googleClientId,
      clientSecret: googleClientSecret,
      adminEmails: googleEmails,
      redirectUri: optional('GOOGLE_REDIRECT_URI')?.trim() || `${publicBaseUrl}/admin/auth/google/callback`,
    },
    store: { driver, path: storePath },
    uploadsPath,
    uploadsBlockedReason,
    email: {
      provider: str('EMAIL_PROVIDER', 'dry_run'),
      from: str('MAIL_FROM', 'Newsletter <newsletter@example.com>'),
      replyTo: optional('MAIL_REPLY_TO'),
      unsubscribeMailto: optional('UNSUBSCRIBE_MAILTO'),
      webhookUrl: optional('WEBHOOK_URL'),
      webhookSecret: optional('WEBHOOK_SECRET'),
      resendApiKey: optional('RESEND_API_KEY'),
      zeaburEndpoint: optional('ZEABUR_ENDPOINT'),
      zeaburToken: optional('ZEABUR_TOKEN'),
      insforgeUrl: optional('INSFORGE_URL'),
      insforgeApiKey: optional('INSFORGE_API_KEY'),
      portalyApiKey: optional('PORTALY_EMAIL_API_KEY'),
      portalyApiHost: optional('PORTALY_API_HOST'),
      apiKey: optional('EMAIL_API_KEY'),
      apiExtra: optional('EMAIL_API_EXTRA'),
      platformSecrets: {},
    },
    ai: {
      provider,
      apiKey: optional('AI_API_KEY'),
      model: optional('AI_MODEL') ?? defaultAiModel(provider),
      baseUrl: optional('AI_BASE_URL'),
    },
    doubleOptIn: bool('DOUBLE_OPT_IN', true),
    singleOptInSources: (optional('SINGLE_OPT_IN_SOURCES') ?? '').split(',').map((v) => v.trim().toLowerCase()).filter(Boolean),
    corsOrigins: corsRaw === '*' ? ['*'] : corsRaw.split(',').map((o) => o.trim()).filter(Boolean),
    publicRateLimitPerMin: num('PUBLIC_RATE_LIMIT_PER_MIN', 20),
    trackingEnabled: bool('TRACKING_ENABLED', true),
    ingestSecret: optional('INGEST_SECRET'),
    webhookSecrets: {
      resend: optional('RESEND_WEBHOOK_SECRET'),
      sesTopicArn: optional('SES_SNS_TOPIC_ARN'),
      postmark: optional('POSTMARK_WEBHOOK_SECRET'),
      sendgrid: optional('SENDGRID_WEBHOOK_PUBLIC_KEY'),
      mailgun: optional('MAILGUN_WEBHOOK_SIGNING_KEY'),
      brevo: optional('BREVO_WEBHOOK_SECRET'),
      mailchimp: optional('MAILCHIMP_WEBHOOK_KEY'),
      generic: optional('GENERIC_WEBHOOK_SECRET'),
      mailersend: optional('MAILERSEND_WEBHOOK_SIGNING_SECRET'),
      sparkpost: optional('SPARKPOST_WEBHOOK_TOKEN'),
      smtp2go: optional('SMTP2GO_WEBHOOK_SECRET'),
      plunk: optional('PLUNK_WEBHOOK_SECRET'),
      elasticemail: optional('ELASTICEMAIL_WEBHOOK_TOKEN'),
    },
    physicalAddress: optional('PHYSICAL_ADDRESS'),
    privacyUrl: optional('PRIVACY_URL'),
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
      autoResume: bool('SEND_AUTO_RESUME', false),
      timeBudgetMs: Math.max(0, num('SEND_TIME_BUDGET_MS', onVercel ? 240_000 : 0)),
      paused: bool('SEND_PAUSED', false),
    },
    scheduler: {
      enabled: bool('SCHEDULER_ENABLED', !onVercel),
      pollMs: Math.max(1000, num('SCHEDULER_POLL_MS', 30_000)),
      cronSecret: optional('CRON_SECRET'),
    },
    isProduction,
    warnings,
  };
}

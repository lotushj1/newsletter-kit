import { afterEach, describe, expect, it } from 'vitest';
import { isTempPath, loadConfig } from '../src/config.js';

const keys = [
  'ADMIN_TOKEN',
  'ALLOW_EPHEMERAL_STORAGE',
  'APP_SECRET',
  'NODE_ENV',
  'PUBLIC_BASE_URL',
  'SCHEDULER_ENABLED',
  'STORE_DRIVER',
  'STORE_PATH',
  'UPLOADS_PATH',
  'VERCEL',
  'VERCEL_URL',
] as const;

const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of keys) {
    const value = original[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function onVercel(): void {
  for (const key of ['STORE_DRIVER', 'STORE_PATH', 'UPLOADS_PATH', 'SCHEDULER_ENABLED', 'PUBLIC_BASE_URL', 'ALLOW_EPHEMERAL_STORAGE']) {
    delete process.env[key];
  }
  process.env.VERCEL = '1';
  process.env.VERCEL_URL = 'newsletter-kit.vercel.app';
  process.env.NODE_ENV = 'production';
  process.env.APP_SECRET = 'prod-secret';
  process.env.ADMIN_TOKEN = 'prod-admin';
}

function selfHostedProduction(): void {
  for (const key of ['STORE_DRIVER', 'STORE_PATH', 'UPLOADS_PATH', 'VERCEL', 'VERCEL_URL', 'ALLOW_EPHEMERAL_STORAGE']) {
    delete process.env[key];
  }
  process.env.NODE_ENV = 'production';
  process.env.APP_SECRET = 'prod-secret';
  process.env.ADMIN_TOKEN = 'prod-admin';
}

describe('loadConfig', () => {
  it('Vercel 上沒設 STORE_DRIVER 就拒絕啟動，不會默默改用 /tmp 的 JSON', () => {
    onVercel();
    expect(() => loadConfig()).toThrow(/拒絕啟動：沒有設定 STORE_DRIVER/);
  });

  it('Vercel 上的 sqlite／json／memory 都拒絕啟動（只能寫 /tmp 或記憶體）', () => {
    for (const driver of ['sqlite', 'json', 'memory']) {
      onVercel();
      process.env.STORE_DRIVER = driver;
      expect(() => loadConfig(), driver).toThrow(/拒絕啟動/);
    }
  });

  it('ALLOW_EPHEMERAL_STORAGE=true 才允許試跑用 /tmp，並留下警告', () => {
    onVercel();
    process.env.ALLOW_EPHEMERAL_STORAGE = 'true';

    const config = loadConfig();
    expect(config.store.driver).toBe('json');
    expect(config.store.path).toBe('/tmp/newsletter.json');
    expect(config.uploadsPath).toBe('/tmp/newsletter-uploads');
    expect(config.uploadsBlockedReason).toBeUndefined();
    expect(config.warnings.join('\n')).toMatch(/ALLOW_EPHEMERAL_STORAGE=true/);
    expect(config.scheduler.enabled).toBe(false);
    expect(config.publicBaseUrl).toBe('https://newsletter-kit.vercel.app');
  });

  it('Vercel 上用 insforge-tables：正常啟動，圖片走 InsForge Storage，不受 /tmp 上傳限制', () => {
    onVercel();
    process.env.STORE_DRIVER = 'insforge-tables';

    const config = loadConfig();
    expect(config.store.driver).toBe('insforge-tables');
    expect(config.uploadsBlockedReason).toBeUndefined();
    expect(config.warnings.join('\n')).not.toMatch(/ALLOW_EPHEMERAL_STORAGE/);
  });

  it('自架正式環境：sqlite 搭配真實路徑照常啟動', () => {
    selfHostedProduction();
    process.env.STORE_DRIVER = 'sqlite';
    process.env.STORE_PATH = '/var/lib/newsletter/newsletter.db';
    process.env.UPLOADS_PATH = '/var/lib/newsletter/uploads';

    const config = loadConfig();
    expect(config.store).toEqual({ driver: 'sqlite', path: '/var/lib/newsletter/newsletter.db' });
    expect(config.uploadsBlockedReason).toBeUndefined();
  });

  it('自架正式環境：沒設 STORE_DRIVER、或 STORE_PATH 在 /tmp 都拒絕啟動', () => {
    selfHostedProduction();
    expect(() => loadConfig()).toThrow(/沒有設定 STORE_DRIVER/);

    selfHostedProduction();
    process.env.STORE_DRIVER = 'sqlite';
    process.env.STORE_PATH = '/tmp/newsletter.db';
    expect(() => loadConfig()).toThrow(/STORE_PATH 在暫存目錄/);
  });

  it('自架正式環境：UPLOADS_PATH 在 /tmp 時停用上傳並說明原因，不會默默寫進暫存目錄', () => {
    selfHostedProduction();
    process.env.STORE_DRIVER = 'sqlite';
    process.env.STORE_PATH = '/var/lib/newsletter/newsletter.db';
    process.env.UPLOADS_PATH = '/tmp/uploads';

    const config = loadConfig();
    expect(config.uploadsBlockedReason).toMatch(/圖片上傳已停用/);
    expect(config.warnings).toContain(config.uploadsBlockedReason);
  });

  it('開發環境維持原本的預設：sqlite 寫 ./data', () => {
    for (const key of ['STORE_DRIVER', 'STORE_PATH', 'UPLOADS_PATH', 'VERCEL', 'ALLOW_EPHEMERAL_STORAGE']) delete process.env[key];
    process.env.NODE_ENV = 'development';

    const config = loadConfig();
    expect(config.store).toEqual({ driver: 'sqlite', path: './data/newsletter.db' });
    expect(config.uploadsPath).toBe('./data/uploads');
    expect(config.uploadsBlockedReason).toBeUndefined();
  });

  it('isTempPath 認得 /tmp 與系統暫存目錄', () => {
    expect(isTempPath('/tmp/newsletter.db')).toBe(true);
    expect(isTempPath('/tmp')).toBe(true);
    expect(isTempPath(':memory:')).toBe(true);
    expect(isTempPath('/tmpfiles/newsletter.db')).toBe(false);
    expect(isTempPath('./data/newsletter.db')).toBe(false);
  });
});

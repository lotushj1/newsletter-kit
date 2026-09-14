import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const keys = [
  'ADMIN_TOKEN',
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

describe('loadConfig', () => {
  it('Vercel 上預設用 /tmp 的 JSON，並關掉排程', () => {
    delete process.env.STORE_DRIVER;
    delete process.env.STORE_PATH;
    delete process.env.UPLOADS_PATH;
    delete process.env.SCHEDULER_ENABLED;
    delete process.env.PUBLIC_BASE_URL;
    process.env.VERCEL = '1';
    process.env.VERCEL_URL = 'newsletter-kit.vercel.app';
    process.env.NODE_ENV = 'production';
    process.env.APP_SECRET = 'prod-secret';
    process.env.ADMIN_TOKEN = 'prod-admin';

    const config = loadConfig();
    expect(config.store.driver).toBe('json');
    expect(config.store.path).toBe('/tmp/newsletter.json');
    expect(config.uploadsPath).toBe('/tmp/newsletter-uploads');
    expect(config.scheduler.enabled).toBe(false);
    expect(config.publicBaseUrl).toBe('https://newsletter-kit.vercel.app');
  });
});

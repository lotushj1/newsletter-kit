import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error 純 JS 的 Worker 模組，沒有型別宣告
import { runTick, tickSettings } from '../deploy/cloudflare-tick/tick.js';

const ROOT = join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

const TICK_URL = 'https://newsletter.example/api/cron/tick';

function okFetch(status = 200, body = '{"ok":true}') {
  return vi.fn(async () => new Response(body, { status }));
}

describe('Cloudflare tick Worker', () => {
  it('缺 TICK_URL 或 CRON_SECRET：丟出「缺少設定」，完全不發請求', async () => {
    const fetchImpl = okFetch();
    await expect(runTick({ CRON_SECRET: 's' }, fetchImpl)).rejects.toThrow(/missing setting.*TICK_URL/);
    await expect(runTick({ TICK_URL }, fetchImpl)).rejects.toThrow(/missing setting.*CRON_SECRET/);
    await expect(runTick({ TICK_URL: '  ', CRON_SECRET: '' }, fetchImpl)).rejects.toThrow(/TICK_URL、CRON_SECRET/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('TICK_URL 不是 https 網址：不發請求', async () => {
    const fetchImpl = okFetch();
    await expect(runTick({ TICK_URL: 'http://newsletter.example/api/cron/tick', CRON_SECRET: 's' }, fetchImpl)).rejects.toThrow(/https/);
    await expect(runTick({ TICK_URL: 'not a url', CRON_SECRET: 's' }, fetchImpl)).rejects.toThrow(/不是有效的網址/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('帶 Bearer CRON_SECRET POST 到 TICK_URL；2xx 視為成功', async () => {
    const fetchImpl = okFetch();
    const result = await runTick({ TICK_URL, CRON_SECRET: 's3cret' }, fetchImpl);
    expect(result.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledWith(TICK_URL, { method: 'POST', headers: { authorization: 'Bearer s3cret' } });
    expect(tickSettings({ TICK_URL, CRON_SECRET: 's3cret' })).toEqual({ url: TICK_URL, secret: 's3cret' });
  });

  it('非 2xx 或回應 ok:false 都丟錯，讓 Cloudflare 的 cron 標成失敗', async () => {
    await expect(runTick({ TICK_URL, CRON_SECRET: 's' }, okFetch(401, '{"error":"未授權"}'))).rejects.toThrow(/HTTP 401/);
    await expect(runTick({ TICK_URL, CRON_SECRET: 's' }, okFetch(502, 'Bad Gateway'))).rejects.toThrow(/HTTP 502/);
    await expect(runTick({ TICK_URL, CRON_SECRET: 's' }, okFetch(200, '{"ok":false,"error":"store down"}'))).rejects.toThrow(/store down/);
  });

  it('scheduled handler 直接 await，錯誤不會被 waitUntil 吞掉', async () => {
    const worker = (await import('../deploy/cloudflare-tick/index.js' as string)).default as {
      scheduled: (event: unknown, env: unknown, ctx: unknown) => Promise<void>;
    };
    await expect(worker.scheduled({}, {}, { waitUntil: () => undefined })).rejects.toThrow(/missing setting/);
  });

  it('wrangler.toml 不寫死正式網址', () => {
    // 註解裡的示範網址不算；實際設定行不能有網址。
    const toml = read('deploy/cloudflare-tick/wrangler.toml').split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
    expect(toml).not.toMatch(/https?:\/\//);
    expect(toml).not.toMatch(/^\s*TICK_URL\s*=/m);
  });
});

describe('GitHub Actions scheduler-tick', () => {
  const workflow = read('.github/workflows/scheduler-tick.yml');

  /** 取出「Check settings」那一步的 shell 腳本。 */
  function precheckScript(): string {
    const match = /- name: Check settings[\s\S]*?run: \|\n([\s\S]*?)\n\s*- name: Tick/.exec(workflow);
    if (!match?.[1]) throw new Error('找不到 Check settings 步驟');
    return match[1].replace(/^ {10}/gm, '');
  }

  function runPrecheck(env: Record<string, string>) {
    return spawnSync('bash', ['-c', precheckScript()], { env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8' });
  }

  it('沒有寫死的備用網址，TICK_URL 只來自 repo variable', () => {
    expect(workflow).not.toMatch(/vercel\.app/);
    expect(workflow).not.toMatch(/vars\.TICK_URL\s*\|\|/);
    expect(workflow.indexOf('- name: Check settings')).toBeLessThan(workflow.indexOf('- name: Tick'));
  });

  it('缺設定時先檢查的那一步失敗，寫明缺什麼（Tick 那步不會執行）', () => {
    const missingBoth = runPrecheck({ TICK_URL: '', CRON_SECRET: '' });
    expect(missingBoth.status).toBe(1);
    expect(missingBoth.stdout).toMatch(/missing setting/);
    expect(missingBoth.stdout).toMatch(/TICK_URL/);
    expect(missingBoth.stdout).toMatch(/CRON_SECRET/);

    const missingUrl = runPrecheck({ TICK_URL: '', CRON_SECRET: 's' });
    expect(missingUrl.status).toBe(1);
    expect(missingUrl.stdout).toMatch(/TICK_URL/);
    expect(missingUrl.stdout).not.toMatch(/CRON_SECRET/);

    expect(runPrecheck({ TICK_URL: 'http://insecure.example/tick', CRON_SECRET: 's' }).status).toBe(1);
    expect(runPrecheck({ TICK_URL, CRON_SECRET: 's' }).status).toBe(0);
  });
});

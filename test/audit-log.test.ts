import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AuditLogTable } from '../admin/src/pages/AuditLog.js';
import type { InsForgeBackend } from '../src/core/insforge.js';
import { createApp } from '../src/http/app.js';
import { createGoogleAdminSession } from '../src/http/auth.js';
import { handleMcpMessage } from '../src/mcp/protocol.js';
import { callTool } from '../src/mcp/tools.js';
import { recordAudit, sendAction } from '../src/services/audit.js';
import { createCampaign } from '../src/services/campaigns.js';
import type { ServiceContext } from '../src/services/context.js';
import { InsForgeStore } from '../src/store/insforge-store.js';
import { InsForgeTableStore } from '../src/store/insforge-table-store.js';
import { JsonStore } from '../src/store/json-store.js';
import { AUDIT_SNAPSHOT_KEEP, MemoryStore, type MemorySnapshot } from '../src/store/memory-store.js';
import { exportTablesToSnapshot, migrateSnapshot } from '../src/store/snapshot-to-tables.js';
import { SqliteStore } from '../src/store/sqlite-store.js';
import type { AuditEntry, Store } from '../src/store/types.js';
import { fakeAdapter, makeContext, testConfig } from './helpers.js';
import { PgliteTableDb } from './support/pglite-table-db.js';

const T0 = Date.parse('2026-11-01T00:00:00.000Z');
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();
const entry = (id: string, seconds: number, extra: Partial<AuditEntry> = {}): AuditEntry => ({
  id,
  at: at(seconds),
  actor: 'admin-token',
  action: 'campaign.send',
  targetId: 'cmp_1',
  summary: '寄送佇列共 3 筆',
  ...extra,
});

const tempDirs: string[] = [];
const pglites: PgliteTableDb[] = [];
afterEach(async () => {
  await Promise.all(pglites.splice(0).map((db) => db.close()));
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nk-audit-'));
  tempDirs.push(dir);
  return dir;
}

/** 只存一列快照的假 InsForge 後端（不連網路）。 */
function fakeSnapshotBackend(): InsForgeBackend & { current: () => MemorySnapshot | null } {
  let current: MemorySnapshot | null = null;
  return {
    current: () => current,
    async loadSnapshot() {
      return current ? structuredClone(current) : null;
    },
    async saveSnapshot(snapshot) {
      current = structuredClone(snapshot);
    },
    async uploadImage(fileName) {
      return { url: `https://files.example.test/${fileName}` };
    },
    async sendEmail() {
      return {};
    },
  };
}

interface DriverCase {
  name: string;
  open: () => Promise<{ store: Store; reopen?: () => Promise<Store> }>;
}

const DRIVERS: DriverCase[] = [
  { name: 'memory', open: async () => ({ store: new MemoryStore() }) },
  {
    name: 'json',
    open: async () => {
      const path = join(tempDir(), 'data.json');
      return { store: new JsonStore(path), reopen: async () => new JsonStore(path) };
    },
  },
  {
    name: 'sqlite',
    open: async () => {
      const path = join(tempDir(), 'data.db');
      return { store: new SqliteStore(path), reopen: async () => new SqliteStore(path) };
    },
  },
  {
    name: 'insforge（單列快照）',
    open: async () => {
      const backend = fakeSnapshotBackend();
      return {
        store: new InsForgeStore(backend, { nullReadRetryDelaysMs: [] }),
        reopen: async () => new InsForgeStore(backend, { nullReadRetryDelaysMs: [] }),
      };
    },
  },
  {
    name: 'insforge-tables（PGlite）',
    open: async () => {
      const db = await PgliteTableDb.create();
      pglites.push(db);
      return { store: new InsForgeTableStore(db), reopen: async () => new InsForgeTableStore(db) };
    },
  },
];

describe.each(DRIVERS)('操作紀錄 store：$name', ({ open }) => {
  it('只新增、新到舊讀回、同 id 重送不重複、可以限制筆數', async () => {
    const { store, reopen } = await open();
    await store.init();
    await store.appendAuditEntry(entry('aud_1', 0, { targetId: undefined, action: 'subscribers.export', summary: '' }));
    await store.appendAuditEntry(entry('aud_2', 10));
    await store.appendAuditEntry(entry('aud_3', 10, { actor: 'editor@example.test', action: 'campaign.cancel' }));
    await store.appendAuditEntry(entry('aud_2', 10, { summary: '重送的內容不會覆寫' }));

    const items = await store.listAuditEntries();
    expect(items.map((item) => item.id)).toEqual(['aud_3', 'aud_2', 'aud_1']);
    expect(items[1]).toEqual(entry('aud_2', 10));
    expect(items[2]).toEqual(entry('aud_1', 0, { targetId: undefined, action: 'subscribers.export', summary: '' }));
    expect(items[2]?.targetId).toBeUndefined();
    expect((await store.listAuditEntries({ limit: 2 })).map((item) => item.id)).toEqual(['aud_3', 'aud_2']);
    expect(await store.listAuditEntries({ limit: 0 })).toHaveLength(1);

    if (reopen) {
      await store.close();
      const again = await reopen();
      await again.init();
      expect((await again.listAuditEntries()).map((item) => item.id)).toEqual(['aud_3', 'aud_2', 'aud_1']);
      await again.close();
    }
  });
});

describe('操作紀錄不能修改或刪除', () => {
  it('insforge-tables：資料表的 trigger 擋下修改與刪除', async () => {
    const db = await PgliteTableDb.create();
    pglites.push(db);
    const store = new InsForgeTableStore(db);
    await store.appendAuditEntry(entry('aud_1', 0));
    const byId = [{ col: 'id', op: 'eq' as const, value: 'aud_1' }];
    await expect(db.update('nk_audit_log', { summary: '改掉' }, byId)).rejects.toThrow(/只能新增/);
    await expect(db.delete('nk_audit_log', byId)).rejects.toThrow(/只能新增/);
    expect(await store.listAuditEntries()).toEqual([entry('aud_1', 0)]);
  });

  it('sqlite：trigger 擋下修改與刪除', async () => {
    const store = new SqliteStore(join(tempDir(), 'data.db'));
    await store.init();
    await store.appendAuditEntry(entry('aud_1', 0));
    const raw = (store as unknown as { db: { prepare(sql: string): { run(): unknown } } }).db;
    expect(() => raw.prepare("UPDATE audit_log SET summary = 'x'").run()).toThrow(/只能新增/);
    expect(() => raw.prepare('DELETE FROM audit_log').run()).toThrow(/只能新增/);
    await store.close();
  });

  it('記憶體類 driver 只保留最近的紀錄，避免整份快照越長越大', async () => {
    const store = new MemoryStore();
    for (let i = 0; i < AUDIT_SNAPSHOT_KEEP + 5; i += 1) await store.appendAuditEntry(entry(`aud_${i}`, i));
    const items = await store.listAuditEntries({ limit: 500 });
    expect(items).toHaveLength(AUDIT_SNAPSHOT_KEEP);
    expect(items[0]?.id).toBe(`aud_${AUDIT_SNAPSHOT_KEEP + 4}`);
    expect(items.some((item) => item.id === 'aud_4')).toBe(false);
    expect(items.some((item) => item.id === 'aud_5')).toBe(true);
  });
});

describe('搬移／還原腳本的操作紀錄', () => {
  const emptySnapshot = (): MemorySnapshot => ({
    subscribers: [],
    campaigns: [],
    deliveries: [],
    events: [],
    sequences: [],
    sequenceSteps: [],
    enrollments: [],
    folders: [],
    templates: [],
    settings: {},
    campaignStarters: [],
  });

  it('寫入後記一筆 data.restore；只檢查不記；覆寫模式也不改既有紀錄', async () => {
    const db = await PgliteTableDb.create();
    pglites.push(db);
    const store = new InsForgeTableStore(db);
    const backup = { ...emptySnapshot(), auditLog: [entry('aud_old', 0)] };

    await migrateSnapshot(db, backup, { apply: false, audit: { id: 'aud_check', at: at(10), actor: 'ops@example.test' } });
    expect(await store.listAuditEntries()).toEqual([]);

    await migrateSnapshot(db, backup, { apply: true, audit: { id: 'aud_restore_1', at: at(20), actor: 'ops@example.test' } });
    const changed = { ...backup, auditLog: [entry('aud_old', 0, { summary: '備份裡被改過的內容' })] };
    const report = await migrateSnapshot(db, changed, {
      apply: true,
      overwrite: true,
      audit: { id: 'aud_restore_2', at: at(30), actor: 'migrate-script' },
    });
    expect(report.applied).toBe(true);

    const items = await store.listAuditEntries();
    expect(items.map((item) => item.id)).toEqual(['aud_restore_2', 'aud_restore_1', 'aud_old']);
    expect(items[0]).toMatchObject({ action: 'data.restore', actor: 'migrate-script' });
    expect(items[0]?.summary).toContain('覆寫既有列');
    expect(items[1]).toMatchObject({ action: 'data.restore', actor: 'ops@example.test' });
    expect(items[2]).toEqual(entry('aud_old', 0));
  });

  it('nk_audit_log 還沒建立時，匯出與寫入照常（只是沒有紀錄）', async () => {
    const db = await PgliteTableDb.create();
    pglites.push(db);
    await db.pg.exec('DROP TABLE public.nk_audit_log');
    const report = await migrateSnapshot(db, emptySnapshot(), {
      apply: true,
      audit: { id: 'aud_x', at: at(0), actor: 'migrate-script' },
    });
    expect(report.applied).toBe(true);
    expect(report.tables.auditLog).toMatchObject({ snapshot: 0, table: 0 });
    expect((await exportTablesToSnapshot(db)).auditLog).toEqual([]);
  });
});

describe('寫入操作紀錄失敗不影響動作本身', () => {
  it('store 寫不進去時只記警告', async () => {
    class BrokenAuditStore extends MemoryStore {
      override async appendAuditEntry(): Promise<void> {
        throw new Error('nk_audit_log 不存在');
      }
    }
    const store = new BrokenAuditStore();
    const ctx: ServiceContext = { config: testConfig(), store, adapter: fakeAdapter(), ai: null };
    await expect(recordAudit(ctx, 'admin-token', 'subscriber.delete', { targetId: 'sub_1' })).resolves.toBeUndefined();
  });
});

describe('後台 API 與 MCP 會留下操作紀錄', () => {
  const ADMIN_EMAIL = 'editor@example.test';
  let server: Server;
  let base: string;
  let ctx: ServiceContext;

  beforeAll(async () => {
    const made = await makeContext({
      google: {
        clientId: 'test-client.apps.googleusercontent.com',
        // 測試用的假值，每次執行隨機產生。
        clientSecret: randomBytes(16).toString('hex'),
        adminEmails: [ADMIN_EMAIL],
        redirectUri: 'https://newsletter.test/admin/auth/google/callback',
      },
    });
    ctx = made.ctx;
    server = createApp(ctx).listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const call = (path: string, options: RequestInit & { cookie?: string } = {}) =>
    fetch(base + path, {
      ...options,
      headers: {
        'content-type': 'application/json',
        ...(options.cookie ? { cookie: `nk_admin=${encodeURIComponent(options.cookie)}` } : { authorization: 'Bearer test-admin-token' }),
        ...(options.headers ?? {}),
      },
    });

  async function latest(action: string): Promise<AuditEntry | undefined> {
    return (await ctx.store.listAuditEntries({ limit: 500 })).find((item) => item.action === action);
  }

  it('名單：修改、匯入、匯出、刪除；摘要不含 email', async () => {
    const created = await ctx.store.createSubscriber({
      id: 'sub_audit_1',
      email: 'reader-one@example.test',
      status: 'subscribed',
      tags: [],
      createdAt: at(0),
    });

    const patched = await call(`/api/admin/subscribers/${created.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'unsubscribed', name: '讀者' }),
    });
    expect(patched.status).toBe(200);
    expect(await latest('subscriber.update')).toMatchObject({
      actor: 'admin-token',
      targetId: created.id,
      summary: '修改欄位：name、status；狀態：unsubscribed',
    });

    const imported = await call('/api/admin/subscribers/import', {
      method: 'POST',
      body: JSON.stringify({ csv: 'email,name\nreader-two@example.test,二\nreader-three@example.test,三\nnot-an-email,壞' }),
    });
    expect(imported.status).toBe(200);
    expect(await latest('subscribers.import')).toMatchObject({ summary: '新增 2、更新 0、略過 1' });

    expect((await call('/api/admin/subscribers/export.csv')).status).toBe(200);
    expect(await latest('subscribers.export')).toMatchObject({ actor: 'admin-token' });

    expect((await call(`/api/admin/subscribers/${created.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(await latest('subscriber.delete')).toMatchObject({ targetId: created.id });

    const all = JSON.stringify(await ctx.store.listAuditEntries({ limit: 500 }));
    expect(all).not.toMatch(/reader-(one|two|three)@example\.test/);
  });

  it('電子報：排程、取消排程、寄出、對帳、中止、刪除', async () => {
    await ctx.store.createSubscriber({
      id: 'sub_audit_send',
      email: 'send-target@example.test',
      status: 'subscribed',
      tags: [],
      createdAt: at(1),
    });
    const campaign = await createCampaign(ctx, { title: '操作紀錄測試', subject: '主旨', bodyHtml: '<p>內文</p>' });
    const future = new Date(Date.now() + 86_400_000).toISOString();

    expect((await call(`/api/admin/campaigns/${campaign.id}/schedule`, { method: 'POST', body: JSON.stringify({ scheduledAt: future }) })).status).toBe(200);
    expect(await latest('campaign.schedule')).toMatchObject({ targetId: campaign.id, summary: `排程時間 ${future}` });

    expect((await call(`/api/admin/campaigns/${campaign.id}/unschedule`, { method: 'POST' })).status).toBe(200);
    expect(await latest('campaign.unschedule')).toMatchObject({ targetId: campaign.id });

    expect((await call(`/api/admin/campaigns/${campaign.id}/send`, { method: 'POST' })).status).toBe(200);
    const sent = await latest('campaign.send');
    expect(sent).toMatchObject({ targetId: campaign.id, actor: 'admin-token' });
    expect(sent?.summary).toMatch(/^寄送佇列共 \d+ 筆$/);
    // 背景寄送跑完（fake adapter）再對帳，才不會碰到還在寄送中的紀錄。
    for (let i = 0; i < 100 && (await ctx.store.getCampaign(campaign.id))?.status === 'sending'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect((await call(`/api/admin/campaigns/${campaign.id}/reconcile`, { method: 'POST' })).status).toBe(200);
    expect(await latest('campaign.reconcile')).toMatchObject({ targetId: campaign.id, summary: '查 0 筆，確認已寄出 0 筆，仍不明 0 筆' });

    const second = await createCampaign(ctx, { title: '要中止的', subject: '主旨', bodyHtml: '<p>內文</p>' });
    await call(`/api/admin/campaigns/${second.id}/schedule`, { method: 'POST', body: JSON.stringify({ scheduledAt: future }) });
    expect((await call(`/api/admin/campaigns/${second.id}/cancel`, { method: 'POST' })).status).toBe(200);
    expect(await latest('campaign.cancel')).toMatchObject({ targetId: second.id });

    expect((await call(`/api/admin/campaigns/${second.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(await latest('campaign.delete')).toMatchObject({ targetId: second.id });
  });

  it('寄出前已是「已寄出」的電子報記成重寄失敗的收件人', async () => {
    const campaign = await createCampaign(ctx, { title: '重寄判斷', subject: '主旨', bodyHtml: '<p>內文</p>' });
    expect(await sendAction(ctx, campaign.id)).toBe('campaign.send');
    await ctx.store.updateCampaign(campaign.id, { status: 'sent' });
    expect(await sendAction(ctx, campaign.id)).toBe('campaign.resend_failed');
  });

  it('Google 登入的人記成自己的 email；設定只記欄位名稱、不記金鑰', async () => {
    const cookie = createGoogleAdminSession(ctx.config, ADMIN_EMAIL);
    const brand = await call('/api/admin/brand', {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ physicalAddress: '測試地址 1 號', privacyUrl: 'https://example.test/privacy' }),
    });
    expect(brand.status).toBe(200);
    expect(await latest('settings.brand')).toMatchObject({
      actor: ADMIN_EMAIL,
      summary: '修改欄位：physicalAddress、privacyUrl',
    });

    const fakeSecret = randomBytes(12).toString('hex');
    const email = await call('/api/admin/integrations/email', {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({
        provider: 'webhook',
        from: 'Test <test@example.test>',
        webhookUrl: 'https://hooks.example.test/mail',
        webhookSecret: fakeSecret,
      }),
    });
    expect(email.status).toBe(200);
    const record = await latest('settings.email');
    expect(record).toMatchObject({ actor: ADMIN_EMAIL, summary: '寄信服務：webhook；更新金鑰：webhookSecret' });
    expect(JSON.stringify(await ctx.store.listAuditEntries({ limit: 500 }))).not.toContain(fakeSecret);
  });

  it('MCP（HTTP）用同一個 actor 規則，摘要標明 MCP', async () => {
    await ctx.store.createSubscriber({
      id: 'sub_audit_mcp',
      email: 'mcp-target@example.test',
      status: 'subscribed',
      tags: [],
      createdAt: at(2),
    });
    const response = await call('/mcp', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'delete_subscriber', arguments: { id: 'sub_audit_mcp' } },
      }),
    });
    expect(response.status).toBe(200);
    expect(await latest('subscriber.delete')).toMatchObject({
      actor: 'admin-token',
      targetId: 'sub_audit_mcp',
      summary: 'MCP：刪除訂閱者',
    });
  });

  it('操作紀錄 API 只給登入的管理者，新到舊', async () => {
    expect((await fetch(`${base}/api/admin/audit-log`)).status).toBe(401);
    const response = await call('/api/admin/audit-log?limit=3');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: AuditEntry[] };
    expect(body.items).toHaveLength(3);
    const times = body.items.map((item) => item.at);
    expect([...times].sort().reverse()).toEqual(times);
  });
});

describe('本機 MCP（stdio）', () => {
  it('handleMcpMessage 帶入的 actor 會寫進紀錄；callTool 預設是 admin-token', async () => {
    const { ctx, store } = await makeContext();
    await store.createSubscriber({ id: 'sub_a', email: 'a@example.test', status: 'subscribed', tags: [], createdAt: at(0) });
    await store.createSubscriber({ id: 'sub_b', email: 'b@example.test', status: 'subscribed', tags: [], createdAt: at(0) });
    await handleMcpMessage(
      ctx,
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'delete_subscriber', arguments: { id: 'sub_a' } } },
      { actor: 'local-mcp' },
    );
    await callTool(ctx, 'update_subscriber', { id: 'sub_b', tags: ['vip'] });
    const items = await store.listAuditEntries();
    expect(items.find((item) => item.targetId === 'sub_a')).toMatchObject({ actor: 'local-mcp', action: 'subscriber.delete' });
    expect(items.find((item) => item.targetId === 'sub_b')).toMatchObject({
      actor: 'admin-token',
      action: 'subscriber.update',
      summary: 'MCP：修改欄位：tags',
    });
  });
});

describe('後台「操作紀錄」頁', () => {
  it('列出時間、執行者、動作名稱、對象與說明；沒有紀錄時顯示空狀態', () => {
    const html = renderToStaticMarkup(
      createElement(AuditLogTable, {
        items: [
          entry('aud_1', 0, { actor: 'editor@example.test', action: 'subscriber.delete', targetId: 'sub_9', summary: '刪除訂閱者' }),
          entry('aud_2', 5, { action: 'data.restore', targetId: undefined, summary: '從快照寫入逐表資料' }),
        ],
      }),
    );
    expect(html).toContain('editor@example.test');
    expect(html).toContain('刪除訂閱者');
    expect(html).toContain('還原／搬移資料');
    expect(html).toContain('sub_9');
    expect(html).not.toContain('<input');
    expect(renderToStaticMarkup(createElement(AuditLogTable, { items: [] }))).toContain('還沒有操作紀錄');
  });
});

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/http/app.js';
import { handleMcpMessage } from '../src/mcp/protocol.js';
import { callTool, TOOLS } from '../src/mcp/tools.js';
import type { ServiceContext } from '../src/services/context.js';
import { makeContext } from './helpers.js';

let server: Server;
let base: string;
let ctx: ServiceContext;

beforeAll(async () => {
  const made = await makeContext();
  ctx = made.ctx;
  server = createApp(ctx).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const rpc = (body: unknown, token = 'test-admin-token') =>
  fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

describe('MCP 協定', () => {
  it('tools/list 涵蓋後台同一套操作', () => {
    const names = TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(expect.arrayContaining([
      'get_session',
      'get_overview',
      'get_brand',
      'update_brand',
      'get_integrations',
      'update_email_integration',
      'update_ai_integration',
      'verify_email',
      'verify_ai',
      'upload_image',
      'draft_campaign',
      'rewrite_selection',
      'suggest_subjects',
      'organize_subscribers',
      'organize_campaigns',
      'filter_list',
      'draft_automation',
      'apply_automation',
      'list_campaigns',
      'get_campaign',
      'create_campaign',
      'update_campaign',
      'delete_campaign',
      'preview_campaign',
      'schedule_campaign',
      'unschedule_campaign',
      'send_campaign',
      'send_test_email',
      'cancel_campaign',
      'get_campaign_stats',
      'list_deliveries',
      'copy_campaign',
      'bulk_campaigns',
      'save_campaign_template',
      'list_subscribers',
      'export_subscribers',
      'list_subscriber_tags',
      'create_subscriber',
      'subscribe',
      'import_subscribers',
      'update_subscriber',
      'delete_subscriber',
      'list_folders',
      'create_folder',
      'update_folder',
      'delete_folder',
      'list_sequences',
      'get_sequence',
      'create_sequence',
      'update_sequence',
      'delete_sequence',
      'copy_sequence',
      'list_enrollments',
      'list_campaign_templates',
      'get_campaign_template',
      'create_campaign_template',
      'update_campaign_template',
      'delete_campaign_template',
      'copy_campaign_template',
      'list_templates',
      'create_template',
      'update_template',
      'delete_template',
    ]));
  });

  it('能建立草稿並讀回', async () => {
    const created = await handleMcpMessage(ctx, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'create_campaign', arguments: { title: 'MCP 草稿', bodyHtml: '<p>內容</p>' } },
    });
    expect(created.kind).toBe('body');
    const envelope = created.kind === 'body' ? (created.json as { result: { structuredContent: { id: string } } }) : null;
    const id = envelope?.result.structuredContent.id;
    expect(id).toMatch(/^cmp_/);

    const listed = await handleMcpMessage(ctx, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'list_campaigns', arguments: { search: 'MCP' } },
    });
    expect(listed.kind).toBe('body');
    const list = listed.kind === 'body'
      ? (listed.json as { result: { structuredContent: { items: { id: string }[] } } })
      : null;
    expect(list?.result.structuredContent.items[0]?.id).toBe(id);
  });

  it('能更新品牌簽名', async () => {
    const result = await handleMcpMessage(ctx, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'update_brand', arguments: { writerName: '測試作者', unsubscribeLabel: '退訂' } },
    });
    expect(result.kind).toBe('body');
    const brand = result.kind === 'body'
      ? (result.json as { result: { structuredContent: { writerName: string; unsubscribeLabel: string } } })
      : null;
    expect(brand?.result.structuredContent).toMatchObject({ writerName: '測試作者', unsubscribeLabel: '退訂' });
  });

  it('能更新並刪除名單', async () => {
    const created = await handleMcpMessage(ctx, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'subscribe',
        arguments: { email: 'mcp-edit@example.com', name: '舊名' },
      },
    });
    expect(created.kind).toBe('body');
    const createdBody = created.kind === 'body'
      ? (created.json as { result: { structuredContent: { subscriber: { id: string } } } })
      : null;
    const id = createdBody?.result.structuredContent.subscriber.id;
    expect(id).toMatch(/^sub_/);

    const updated = await handleMcpMessage(ctx, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'update_subscriber', arguments: { id, name: '新名' } },
    });
    expect(updated.kind).toBe('body');
    const updatedBody = updated.kind === 'body'
      ? (updated.json as { result: { structuredContent: { name: string } } })
      : null;
    expect(updatedBody?.result.structuredContent.name).toBe('新名');

    const removed = await handleMcpMessage(ctx, {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'delete_subscriber', arguments: { id } },
    });
    expect(removed.kind).toBe('body');
    expect(await ctx.store.getSubscriber(id!)).toBeNull();
  });

  it('複製自動化會停用，而且不重新啟用來源', async () => {
    const campaign = await callTool(ctx, 'create_campaign', {
      title: 'MCP 序列信',
      bodyHtml: '<p>嗨</p>',
    }) as { id: string };
    const source = await callTool(ctx, 'create_sequence', {
      name: 'MCP 歡迎',
      trigger: 'subscribe',
      enabled: true,
      steps: [{ delayDays: 0, campaignId: campaign.id }],
    }) as { id: string; enabled: boolean; steps: { id: string }[] };
    const copy = await callTool(ctx, 'copy_sequence', { id: source.id }) as {
      id: string;
      name: string;
      enabled: boolean;
      steps: { id: string; campaignId: string }[];
    };
    expect(copy.enabled).toBe(false);
    expect(copy.name).toBe('MCP 歡迎（副本）');
    expect(copy.id).not.toBe(source.id);
    expect(copy.steps[0]?.campaignId).toBe(campaign.id);
    expect(copy.steps[0]?.id).not.toBe(source.steps[0]?.id);
    const stored = await ctx.store.getSequence(source.id);
    expect(stored?.enabled).toBe(true);
    expect(await ctx.store.listEnrollments(copy.id)).toEqual([]);
    await callTool(ctx, 'delete_sequence', { id: copy.id });
    await callTool(ctx, 'delete_sequence', { id: source.id });
  });

  it('套用自動化建議時序列維持停用', async () => {
    const applied = await callTool(ctx, 'apply_automation', {
      name: 'MCP 套用',
      trigger: 'subscribe',
      triggerValue: '',
      enabled: true,
      steps: [{ delayDays: 0, title: '第一封', preheader: '嗨', bodyHtml: '<p>你好</p>' }],
    }) as { sequence: { id: string; enabled: boolean } };
    expect(applied.sequence.enabled).toBe(false);
    await callTool(ctx, 'delete_sequence', { id: applied.sequence.id });
  });

  it('預覽可以吃尚未存檔的正文', async () => {
    const campaign = await callTool(ctx, 'create_campaign', {
      title: 'MCP 預覽',
      bodyHtml: '<p>舊正文</p>',
    }) as { id: string };
    const preview = await callTool(ctx, 'preview_campaign', {
      id: campaign.id,
      subject: '預覽主旨',
      bodyHtml: '<p>預覽正文</p>',
    }) as { subject: string; html: string; audienceCount: number };
    expect(preview.subject).toContain('預覽主旨');
    expect(preview.html).toContain('預覽正文');
    expect(preview.audienceCount).toBeGreaterThanOrEqual(0);
  });

  it('內容區塊與資料夾可以改名後刪除', async () => {
    const folder = await callTool(ctx, 'create_folder', { name: 'MCP 分類' }) as { id: string };
    const listed = await callTool(ctx, 'list_folders', {}) as {
      items: { id: string; name: string; count: number }[];
    };
    expect(listed.items.find((item) => item.id === folder.id)).toMatchObject({ name: 'MCP 分類', count: 0 });
    const renamed = await callTool(ctx, 'update_folder', { id: folder.id, name: '改過的分類' }) as { name: string };
    expect(renamed.name).toBe('改過的分類');
    await callTool(ctx, 'delete_folder', { id: folder.id });

    const template = await callTool(ctx, 'create_template', {
      name: 'MCP 區塊',
      html: '<p>區塊</p>',
    }) as { id: string };
    const updated = await callTool(ctx, 'update_template', {
      id: template.id,
      html: '<p>新區塊</p>',
    }) as { html: string };
    expect(updated.html).toBe('<p>新區塊</p>');
    await callTool(ctx, 'delete_template', { id: template.id });
  });

  it('整合設定不會把金鑰回傳出去', async () => {
    const made = await makeContext();
    const secret = 'mcp-secret-do-not-echo';
    const view = await callTool(made.ctx, 'update_ai_integration', {
      provider: 'openai',
      apiKey: secret,
    }) as { ai: { apiKeySet: boolean } };
    expect(JSON.stringify(view)).not.toContain(secret);
    expect(view.ai.apiKeySet).toBe(true);
  });
});

describe('MCP HTTP', () => {
  it('沒帶 token 回 401', async () => {
    const response = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize' }, '');
    expect(response.status).toBe(401);
  });

  it('initialize 與 tools/list', async () => {
    const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(init.status).toBe(200);
    const initBody = await init.json();
    expect(initBody.result.serverInfo.name).toBe('newsletter-kit');
    expect(initBody.result.capabilities.tools).toEqual({});

    const listed = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const body = await listed.json();
    expect(body.result.tools.some((tool: { name: string }) => tool.name === 'get_session')).toBe(true);
  });

  it('session 會回 MCP 與 Admin API 位址', async () => {
    const response = await rpc({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'get_session', arguments: {} },
    });
    const body = await response.json();
    expect(body.result.structuredContent.mcpUrl).toBe('https://newsletter.test/mcp');
    expect(body.result.structuredContent.adminApiUrl).toBe('https://newsletter.test/api/admin');
  });

  it('跨網域預檢允許 Authorization', async () => {
    const response = await fetch(`${base}/mcp`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://agent.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, content-type',
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://agent.example');
    expect(response.headers.get('access-control-allow-headers')).toMatch(/authorization/i);
  });
});

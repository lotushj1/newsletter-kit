import { loadConfig, loadEnvFile } from '../config.js';
import { createEmailAdapter } from '../email/registry.js';
import {
  createCampaign,
  getCampaign,
  listCampaigns,
  overviewRates,
  scheduleCampaign,
  updateCampaign,
} from '../services/campaigns.js';
import type { ServiceContext } from '../services/context.js';
import { startCampaign } from '../services/sending.js';
import { createFolder, listFolders } from '../services/folders.js';
import { importSubscribersCsv, listSubscribers, subscribe } from '../services/subscribers.js';
import { createStore } from '../store/index.js';
import type { CampaignStatus } from '../store/types.js';

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: ToolDefinition[] = [
  {
    name: 'get_overview',
    description: '訂閱人數與最近電子報',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_campaigns',
    description: '列出電子報，可依狀態或關鍵字篩選',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string' },
        search: { type: 'string' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'get_campaign',
    description: '讀取單篇電子報（含開信／點擊）',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'create_campaign',
    description: '建立草稿。內文可用 bodyHtml 或 bodyMarkdown',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        subject: { type: 'string' },
        preheader: { type: 'string' },
        bodyHtml: { type: 'string' },
        bodyMarkdown: { type: 'string' },
        audienceTags: { type: 'array', items: { type: 'string' } },
        audienceFolderId: { type: 'string' },
      },
      required: ['title'],
    },
  },
  {
    name: 'update_campaign',
    description: '更新尚未寄出的電子報',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        subject: { type: 'string' },
        preheader: { type: 'string' },
        bodyHtml: { type: 'string' },
        bodyMarkdown: { type: 'string' },
        audienceTags: { type: 'array', items: { type: 'string' } },
        audienceFolderId: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'schedule_campaign',
    description: '排程寄送，scheduledAt 為 ISO 時間',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, scheduledAt: { type: 'string' } },
      required: ['id', 'scheduledAt'],
    },
  },
  {
    name: 'send_campaign',
    description: '立刻開始寄送（背景執行）',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'list_subscribers',
    description: '查詢名單',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string' },
        status: { type: 'string' },
        tag: { type: 'string' },
        folderId: { type: 'string' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'list_folders',
    description: '列出分類資料夾',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'create_folder',
    description: '新增分類資料夾',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
  {
    name: 'subscribe',
    description: '新增或重新訂閱一位讀者',
    inputSchema: {
      type: 'object',
      properties: {
        email: { type: 'string' },
        name: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        source: { type: 'string' },
      },
      required: ['email'],
    },
  },
  {
    name: 'import_subscribers',
    description: '用 CSV 文字匯入名單',
    inputSchema: {
      type: 'object',
      properties: {
        csv: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['csv'],
    },
  },
];

async function callTool(
  ctx: ServiceContext,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case 'get_overview': {
      const counts = await ctx.store.countSubscribersByStatus();
      const recent = await listCampaigns(ctx, { limit: 8 });
      const rates = await overviewRates(ctx);
      return { counts, campaigns: recent.items, provider: ctx.adapter.name, rates };
    }
    case 'list_campaigns':
      return listCampaigns(ctx, {
        status: typeof args.status === 'string' ? (args.status as CampaignStatus) : undefined,
        search: typeof args.search === 'string' ? args.search : undefined,
        limit: typeof args.limit === 'number' ? args.limit : 20,
      });
    case 'get_campaign':
      return getCampaign(ctx, String(args.id ?? ''));
    case 'create_campaign':
      return createCampaign(ctx, args);
    case 'update_campaign': {
      const { id, ...rest } = args;
      return updateCampaign(ctx, String(id ?? ''), rest);
    }
    case 'schedule_campaign':
      return scheduleCampaign(ctx, String(args.id ?? ''), args.scheduledAt);
    case 'send_campaign':
      return startCampaign(ctx, String(args.id ?? ''), { background: true });
    case 'list_subscribers':
      return listSubscribers(ctx, {
        search: typeof args.search === 'string' ? args.search : undefined,
        status: typeof args.status === 'string' ? (args.status as never) : undefined,
        tag: typeof args.tag === 'string' ? args.tag : undefined,
        folderId: typeof args.folderId === 'string' ? args.folderId : undefined,
        limit: typeof args.limit === 'number' ? args.limit : 50,
      });
    case 'list_folders':
      return { items: await listFolders(ctx) };
    case 'create_folder':
      return createFolder(ctx, { name: args.name });
    case 'subscribe':
      return subscribe(ctx, { email: args.email, name: args.name, tags: args.tags, source: args.source });
    case 'import_subscribers':
      return importSubscribersCsv(
        ctx,
        String(args.csv ?? ''),
        Array.isArray(args.tags) ? args.tags.map(String) : [],
      );
    default:
      throw new Error(`未知的工具：${name}`);
  }
}

function reply(id: string | number | null | undefined, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result })}\n`);
}

function replyError(id: string | number | null | undefined, message: string): void {
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code: -32000, message } })}\n`,
  );
}

export async function createMcpContext(): Promise<ServiceContext> {
  loadEnvFile();
  const config = loadConfig();
  const store = createStore(config.store.driver, config.store.path);
  await store.init();
  const adapter = createEmailAdapter({
    provider: config.email.provider,
    webhookUrl: config.email.webhookUrl,
    webhookSecret: config.email.webhookSecret,
    resendApiKey: config.email.resendApiKey,
    zeaburEndpoint: config.email.zeaburEndpoint,
    zeaburToken: config.email.zeaburToken,
    insforgeUrl: config.email.insforgeUrl,
    insforgeApiKey: config.email.insforgeApiKey,
  });
  return { config, store, adapter };
}

export async function startMcpServer(ctx: ServiceContext): Promise<void> {
  process.stdin.setEncoding('utf8');
  let buffer = '';
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      void handleLine(ctx, trimmed);
    }
  });
}

async function handleLine(ctx: ServiceContext, line: string): Promise<void> {
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(line) as JsonRpcRequest;
  } catch {
    replyError(null, '無效的 JSON');
    return;
  }
  try {
    switch (request.method) {
      case 'initialize':
        reply(request.id, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'newsletter-kit', version: '0.1.0' },
        });
        return;
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return;
      case 'tools/list':
        reply(request.id, { tools: TOOLS });
        return;
      case 'tools/call': {
        const name = String(request.params?.name ?? '');
        const args = (request.params?.arguments ?? {}) as Record<string, unknown>;
        const result = await callTool(ctx, name, args);
        reply(request.id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
        return;
      }
      case 'ping':
        reply(request.id, {});
        return;
      default:
        replyError(request.id, `不支援的方法：${request.method ?? ''}`);
    }
  } catch (error) {
    replyError(request.id, error instanceof Error ? error.message : '工具執行失敗');
  }
}

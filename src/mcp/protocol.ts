import { AppError } from '../core/errors.js';
import type { ServiceContext } from '../services/context.js';
import { callTool, TOOLS } from './tools.js';

export const MCP_PROTOCOL_VERSION = '2024-11-05';
export const MCP_SERVER_INFO = { name: 'newsletter-kit', version: '0.1.0' };
export const MCP_INSTRUCTIONS =
  '電子報後台。工具與後台同一套：電子報、名單、資料夾、自動化、模板、品牌、寄信與 AI 設定。回傳不含金鑰。AI 只給建議，套用自動化時序列維持停用。寄信需已接 Email adapter。授權用 ADMIN_TOKEN。';

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
}

export type McpHandleResult =
  | { kind: 'empty' }
  | { kind: 'body'; json: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function rpcResult(id: JsonRpcId, result: unknown) {
  return { jsonrpc: '2.0' as const, id, result };
}

function rpcError(id: JsonRpcId, code: number, message: string) {
  return { jsonrpc: '2.0' as const, id, error: { code, message } };
}

function errorCode(error: unknown): number {
  if (typeof error === 'object' && error && 'rpcCode' in error && typeof error.rpcCode === 'number') {
    return error.rpcCode;
  }
  if (error instanceof AppError) {
    if (error.status === 400) return -32602;
    if (error.status === 404) return -32004;
    return -32000;
  }
  return -32603;
}

async function handleOne(ctx: ServiceContext, raw: unknown): Promise<McpHandleResult> {
  if (!isRecord(raw) || typeof raw.method !== 'string') {
    return { kind: 'body', json: rpcError(null, -32600, '無效的 JSON-RPC 請求') };
  }
  const request = raw as JsonRpcRequest;
  const method = raw.method;
  const id = request.id === undefined ? null : request.id;
  const isNotification = request.id === undefined && method.startsWith('notifications/');

  try {
    switch (method) {
      case 'initialize':
        return {
          kind: 'body',
          json: rpcResult(id, {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: MCP_SERVER_INFO,
            instructions: MCP_INSTRUCTIONS,
          }),
        };
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return { kind: 'empty' };
      case 'ping':
        return { kind: 'body', json: rpcResult(id, {}) };
      case 'tools/list':
        return { kind: 'body', json: rpcResult(id, { tools: TOOLS }) };
      case 'tools/call': {
        const params = isRecord(request.params) ? request.params : {};
        const name = typeof params.name === 'string' ? params.name : '';
        const args = isRecord(params.arguments) ? params.arguments : {};
        if (!name) return { kind: 'body', json: rpcError(id, -32602, '缺少 tool 名稱') };
        const result = await callTool(ctx, name, args);
        return {
          kind: 'body',
          json: rpcResult(id, {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
          }),
        };
      }
      default:
        if (isNotification) return { kind: 'empty' };
        return { kind: 'body', json: rpcError(id, -32601, `不支援的方法：${method}`) };
    }
  } catch (error) {
    if (isNotification) return { kind: 'empty' };
    const message = error instanceof Error ? error.message : '工具執行失敗';
    return { kind: 'body', json: rpcError(id, errorCode(error), message) };
  }
}

export async function handleMcpMessage(ctx: ServiceContext, raw: unknown): Promise<McpHandleResult> {
  if (Array.isArray(raw)) {
    if (raw.length === 0) {
      return { kind: 'body', json: rpcError(null, -32600, '空的 JSON-RPC 批次') };
    }
    const parts = await Promise.all(raw.map((item) => handleOne(ctx, item)));
    const messages = parts.filter((part) => part.kind === 'body').map((part) => part.json);
    if (messages.length === 0) return { kind: 'empty' };
    return { kind: 'body', json: messages };
  }
  return handleOne(ctx, raw);
}

export function encodeMcpBody(json: unknown): string {
  return `${JSON.stringify(json)}\n`;
}

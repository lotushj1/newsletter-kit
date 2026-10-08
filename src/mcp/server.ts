import { loadConfig, loadEnvFile } from '../config.js';
import { createAiAdapter } from '../ai/registry.js';
import { createEmailAdapter } from '../email/registry.js';
import type { ServiceContext } from '../services/context.js';
import { applyStoredIntegrations, emailAdapterContext } from '../services/integrations.js';
import { createStore } from '../store/index.js';
import { encodeMcpBody, handleMcpMessage } from './protocol.js';

export async function createMcpContext(): Promise<ServiceContext> {
  loadEnvFile();
  const config = loadConfig();
  const store = createStore(config.store.driver, config.store.path);
  await store.init();
  await applyStoredIntegrations(config, store);
  const adapter = createEmailAdapter(emailAdapterContext(config));
  return { config, store, adapter, ai: createAiAdapter(config.ai) };
}

function writeStdout(json: unknown): void {
  process.stdout.write(encodeMcpBody(json));
}

async function handleStdioLine(ctx: ServiceContext, line: string): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    writeStdout({ jsonrpc: '2.0', id: null, error: { code: -32700, message: '無效的 JSON' } });
    return;
  }
  const result = await handleMcpMessage(ctx, parsed);
  if (result.kind === 'body') writeStdout(result.json);
}

export async function startMcpServer(ctx: ServiceContext): Promise<void> {
  process.stdin.setEncoding('utf8');
  let buffer = '';
  let queue = Promise.resolve();
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      queue = queue.then(() => handleStdioLine(ctx, trimmed));
    }
  });
}

/** 本機 stdio 轉打已架好的服務，給只支援 command 的 MCP 客戶端。 */
export async function startRemoteStdioProxy(baseUrl: string, token: string): Promise<void> {
  const endpoint = `${baseUrl.replace(/\/$/, '')}/mcp`;
  process.stdin.setEncoding('utf8');
  let buffer = '';
  let queue = Promise.resolve();

  const send = async (line: string) => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: line,
    });
    if (response.status === 202) return;
    const text = await response.text();
    if (!text) return;
    process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
  };

  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      queue = queue.then(() => send(trimmed));
    }
  });
}

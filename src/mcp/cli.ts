import { loadEnvFile } from '../config.js';
import { logger } from '../core/logger.js';
import { createMcpContext, startMcpServer, startRemoteStdioProxy } from './server.js';

function remoteUrl(): string | undefined {
  const value = process.env.NEWSLETTER_URL?.trim();
  return value ? value.replace(/\/$/, '') : undefined;
}

async function main(): Promise<void> {
  loadEnvFile();
  const url = remoteUrl();
  if (url) {
    const token = process.env.ADMIN_TOKEN?.trim();
    if (!token) {
      throw new Error('連遠端 MCP 需要 ADMIN_TOKEN');
    }
    logger.info('MCP server 已啟動（stdio → 遠端）', { url });
    await startRemoteStdioProxy(url, token);
    return;
  }

  const ctx = await createMcpContext();
  logger.info('MCP server 已啟動（stdio）', { store: ctx.store.driver });
  await startMcpServer(ctx);
}

main().catch((error: unknown) => {
  logger.error('MCP 啟動失敗', { error: (error as Error).message });
  process.exitCode = 1;
});

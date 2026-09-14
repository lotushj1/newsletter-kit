import { logger } from '../core/logger.js';
import { createMcpContext, startMcpServer } from './server.js';

async function main(): Promise<void> {
  const ctx = await createMcpContext();
  logger.info('MCP server 已啟動（stdio）', { store: ctx.store.driver });
  await startMcpServer(ctx);
}

main().catch((error: unknown) => {
  logger.error('MCP 啟動失敗', { error: (error as Error).message });
  process.exitCode = 1;
});

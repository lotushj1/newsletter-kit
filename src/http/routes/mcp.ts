import { Router } from 'express';
import type { ServiceContext } from '../../services/context.js';
import { requireAdmin } from '../auth.js';
import { asyncRoute } from '../helpers.js';
import { handleMcpMessage, MCP_PROTOCOL_VERSION } from '../../mcp/protocol.js';

function applyMcpHeaders(res: { setHeader: (name: string, value: string) => void }): void {
  res.setHeader('content-type', 'application/json');
  res.setHeader('mcp-protocol-version', MCP_PROTOCOL_VERSION);
}

export function mcpRouter(ctx: ServiceContext): Router {
  const router = Router();
  router.use(requireAdmin(ctx.config));

  router.get(
    '/',
    (_req, res) => {
      applyMcpHeaders(res);
      res.status(405).json({ error: 'MCP 請用 POST JSON-RPC' });
    },
  );

  router.post(
    '/',
    asyncRoute(async (req, res) => {
      const result = await handleMcpMessage(ctx, req.body);
      applyMcpHeaders(res);
      if (result.kind === 'empty') {
        res.status(202).end();
        return;
      }
      res.status(200).json(result.json);
    }),
  );

  return router;
}

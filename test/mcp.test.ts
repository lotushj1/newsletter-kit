import { describe, expect, it } from 'vitest';
import { createCampaign } from '../src/services/campaigns.js';
import { makeContext } from './helpers.js';
import { startMcpServer } from '../src/mcp/server.js';

describe('MCP 工具層', () => {
  it('能用既有服務建立草稿並列出', async () => {
    const { ctx } = await makeContext();
    const campaign = await createCampaign(ctx, { title: 'MCP 草稿', bodyHtml: '<p>內容</p>' });
    const listed = await ctx.store.listCampaigns({ search: 'MCP' });
    expect(listed.items[0]?.id).toBe(campaign.id);
    expect(typeof startMcpServer).toBe('function');
  });
});

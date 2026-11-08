import { describe, expect, it } from 'vitest';
import { createApp } from '../src/http/app.js';
import { createCampaign, scheduleCampaign } from '../src/services/campaigns.js';
import { createSubscriber } from '../src/services/subscribers.js';
import { makeContext } from './helpers.js';

async function serve(secret: string | undefined, schedulerEnabled = true) {
  const made = await makeContext({ scheduler: { enabled: schedulerEnabled, pollMs: 1000, cronSecret: undefined } });
  made.ctx.config.scheduler.cronSecret = secret;
  const server = createApp(made.ctx).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  return { ...made, server, base };
}

describe('/api/cron/tick', () => {
  it('SCHEDULER_ENABLED=false 時外部 cron 打進來也不會寄（後台顯示關閉就真的關閉）', async () => {
    const { ctx, server, base, adapter } = await serve('s3cret', false);
    try {
      await createSubscriber(ctx, { email: 'a@example.com', name: '阿明' });
      const campaign = await createCampaign(ctx, { title: 't', bodyMarkdown: '嗨' });
      await scheduleCampaign(ctx, campaign.id, new Date(Date.now() - 1000).toISOString());
      const res = await fetch(`${base}/api/cron/tick`, { headers: { authorization: 'Bearer s3cret' } });
      expect(res.status).toBe(200);
      expect((await res.json()).skippedReason).toBe('scheduler_disabled');
      await new Promise((r) => setTimeout(r, 100));
      expect(adapter.sent).toHaveLength(0);
      expect((await ctx.store.getCampaign(campaign.id))?.status).toBe('scheduled');
    } finally {
      server.close();
    }
  });

  it('沒設 CRON_SECRET 回 503', async () => {
    const { server, base } = await serve(undefined);
    try {
      expect((await fetch(`${base}/api/cron/tick`)).status).toBe(503);
    } finally {
      server.close();
    }
  });

  it('密鑰錯誤回 401，不會寄', async () => {
    const { server, base, adapter } = await serve('s3cret');
    try {
      const res = await fetch(`${base}/api/cron/tick`, { headers: { authorization: 'Bearer nope' } });
      expect(res.status).toBe(401);
      expect(adapter.sent).toHaveLength(0);
    } finally {
      server.close();
    }
  });

  it('時間到的排程電子報會被寄出', async () => {
    const { ctx, server, base, adapter } = await serve('s3cret');
    try {
      await createSubscriber(ctx, { email: 'a@example.com', name: '阿明' });
      const campaign = await createCampaign(ctx, { title: 't', bodyMarkdown: '嗨' });
      await scheduleCampaign(ctx, campaign.id, new Date(Date.now() - 1000).toISOString());
      const res = await fetch(`${base}/api/cron/tick`, { headers: { authorization: 'Bearer s3cret' } });
      expect(res.status).toBe(200);
      for (let i = 0; i < 50 && (await ctx.store.getCampaign(campaign.id))?.status !== 'sent'; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect((await ctx.store.getCampaign(campaign.id))?.status).toBe('sent');
      expect(adapter.sent).toHaveLength(1);
    } finally {
      server.close();
    }
  });
});

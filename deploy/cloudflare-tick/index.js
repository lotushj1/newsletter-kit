// 每分鐘打一次 newsletter-kit 的排程 tick（Vercel Hobby 的 cron 一天只能一次）。
export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil((async () => {
      const res = await fetch(env.TICK_URL, { method: 'POST', headers: { authorization: `Bearer ${env.CRON_SECRET}` } });
      console.log('tick', res.status, (await res.text()).slice(0, 200));
    })());
  },
};

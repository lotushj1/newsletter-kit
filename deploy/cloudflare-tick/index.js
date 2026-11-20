// 每分鐘打一次 newsletter-kit 的排程 tick（Vercel Hobby 的 cron 一天只能一次）。
// TICK_URL 與 CRON_SECRET 都用 `wrangler secret put` 設定，不寫進 wrangler.toml。
import { runTick } from './tick.js';

export default {
  // 直接 await（不用 waitUntil）：設定缺漏或 tick 失敗時丟出的錯誤會讓這次 cron 標成失敗。
  async scheduled(_event, env) {
    await runTick(env);
  },
};

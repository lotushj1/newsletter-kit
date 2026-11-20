# newsletter-kit-tick

Cloudflare Worker，每分鐘（`* * * * *`）以 `Authorization: Bearer $CRON_SECRET` 打 `/api/cron/tick`，讓 Vercel Hobby 上的排程電子報準時寄出。

```bash
npx wrangler secret put TICK_URL      # 完整網址，例如 https://你的網域/api/cron/tick（必須是 https）
npx wrangler secret put CRON_SECRET   # 與 Vercel 的 CRON_SECRET 相同
npx wrangler deploy
```

- 正式網址不寫進 `wrangler.toml`（repo 是公開的），兩個值都用 secret 設定；secret 不會被 `wrangler deploy` 蓋掉。
- 以前用 `[vars]` 設過 `TICK_URL` 的：新版 `wrangler.toml` 部署後那個 var 會被移除，接著用 `wrangler secret put TICK_URL` 補上。中間那幾分鐘 Worker 會因缺設定而報錯，不會發出請求。
- 任一個設定缺漏、`TICK_URL` 不是 https、回應不是 2xx，或回應寫明 `ok: false`，這次 cron 都會標成失敗（Cloudflare 後台 Cron Events 看得到），不會默默成功。

GitHub Actions `scheduler-tick` 與 vercel.json 每日 cron 只是備援。要確認排程有沒有在跑，看後台總覽的「運作狀態」，或讓 uptime 監控輪詢 `/api/cron/readiness`（見 docs/hosting.md）。

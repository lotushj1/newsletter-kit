# newsletter-kit-tick

Cloudflare Worker，每分鐘（`* * * * *`）以 `Authorization: Bearer $CRON_SECRET` 打 `/api/cron/tick`，讓 Vercel Hobby 上的排程電子報準時寄出。

```bash
npx wrangler secret put CRON_SECRET   # 與 Vercel 的 CRON_SECRET 相同
npx wrangler deploy
```

GitHub Actions `scheduler-tick` 與 vercel.json 每日 cron 只是備援。

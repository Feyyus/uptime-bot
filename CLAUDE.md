# 3x3 uptime bot

Telegram bot (grammY) on Cloudflare Workers. Cron every 10 min: checks
3x3.team + ecom-landing reachability and the workstation's `status.json`
(disk usage), DMs subscribed chats only on failure. `/history` shows the
last 30 incidents (kept in KV). Retries transient network blips (2 tries,
300/800ms) before flagging an outage — see the comment in `src/index.js`.

- `SUBSCRIBERS` KV — chat subscribe state + `history` key (JSON array).
- `TELEGRAM_BOT_TOKEN` — Worker secret (`wrangler secret put`), not in repo.

## Deploy

**Via GitHub Actions, not manually.** Push to `master` (touching `src/**`,
`wrangler.toml`, or `package.json`) triggers `.github/workflows/deploy.yml`,
which runs `wrangler deploy` using the `CLOUDFLARE_API_TOKEN` repo secret.
Don't run `wrangler deploy`/`npm run deploy` from a local machine — it'll
still work (same Worker), but then the deployed code and git history can
drift out of sync silently. If you must deploy from local (CI down, urgent
fix), push immediately after so `master` matches what's live.

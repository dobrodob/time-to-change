# Time to Change — Cloudflare Worker

Production runtime for the self-hosted Telegram market-timing assistant. The
Worker receives Telegram webhooks, runs scheduled market analysis, and stores
state in Cloudflare D1.

For the product overview and English documentation, start with the repository
[`README.md`](../README.md) or [`README.en.md`](../README.en.md).

## Runtime surface

| Entry point | Purpose |
|---|---|
| `POST /telegram` | Telegram webhook; requires `X-Telegram-Bot-Api-Secret-Token` |
| `GET /health` | Liveness and analysis-freshness summary |
| `0 * * * *` | Analyze every active asset |
| `25 9 * * *`, `25 10 * * *` | Madrid morning digest across DST |
| `15 */3 * * *` | Market-aware freshness monitor |
| `1 0 * * *` | Reset the daily provider-quota counters |

## Local development

```bash
cd worker
npm ci
cp .dev.vars.example .dev.vars
npm run dev
```

Use placeholder values only in `.dev.vars.example`; real values belong in the
gitignored `.dev.vars` file or in Cloudflare secrets.

Verification:

```bash
npm test                 # unit + Python/TypeScript parity fixtures
npm run typecheck        # tsc --noEmit
npm run lint             # Biome
npm run test:integration # Miniflare D1 in the Workers runtime
```

## First deployment

Create the database and copy the returned ID into `wrangler.toml`:

```bash
npx wrangler login
npx wrangler d1 create euro-dollar-bot-state
npx wrangler d1 migrations apply euro-dollar-bot-state --remote
```

Store secrets without putting them in shell scripts or git:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put TWELVEDATA_API_KEY
```

`TELEGRAM_WEBHOOK_SECRET` must contain at least 32 random characters.

Deploy:

```bash
npx wrangler deploy
```

Install the webhook using the deployed URL and the same secret:

```bash
curl -fsS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  --data-urlencode "url=${WORKER_URL}/telegram" \
  --data-urlencode "secret_token=${TELEGRAM_WEBHOOK_SECRET}" \
  --data-urlencode 'allowed_updates=["message","callback_query"]'
```

Do not paste the resulting token-bearing command or response into an issue or
CI log.

## GitHub Actions deployment

`deploy-worker.yml` is manual and always runs the verification gate before
migration and deploy. Production values live in the protected `production`
GitHub Environment:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `D1_DATABASE_ID`
- `WORKER_HEALTH_URL`

The weekly backup additionally requires `D1_BACKUP_PASSPHRASE` and uploads only
an encrypted artifact. Helper scripts consume protected values internally and
do not forward Wrangler output, deployment identifiers, or endpoints to public
Actions logs.

## Provider routing

| Asset class | Runtime provider |
|---|---|
| Forex, US stocks, indices | Twelve Data |
| MOEX stocks | MOEX ISS |
| `XAU/XAG/XPT/XPD` pairs | Yahoo Finance |
| Crypto pairs | Coinbase Exchange |

The stored D1 provider enum intentionally remains `twelvedata | moex`; metals
and crypto are routed at runtime. Rebuilding the `assets` table only to expand
that enum can cascade into subscriptions and asset state.

## Structure

```text
src/
├── index.ts          HTTP and scheduled entry points
├── env.ts            fail-loud environment validation
├── telegram/         Bot API client, parser, authenticated webhook
├── commands/         handlers and Russian message formatting
├── analyze/          providers, indicators, scoring, gating
├── digest/           per-user morning digest
├── monitor/          freshness and quota checks
├── budget/           conversion pacing
├── state/            D1 repository and Zod schemas
└── lib/              time, logging, HTTP retry, Result helpers

migrations/           versioned D1 schema
tests/unit/            pure behavior and provider tests
tests/parity/          Python → TypeScript identity fixtures
tests/integration/     Miniflare D1 tests
```

## Rollback and recovery

- Cloudflare keeps deployment versions; roll back the Worker from the dashboard
  or with Wrangler.
- D1 Time Travel provides point-in-time restore for supported databases.
- The encrypted weekly export provides a longer-lived operator-controlled copy.
- Restoring D1 is destructive. Record the current bookmark or export before a
  restore and verify `/health` plus one real analyze tick afterward.

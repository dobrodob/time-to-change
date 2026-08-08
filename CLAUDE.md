# Time to Change — repository guide

> AI-agent entry point. Workspace-level rules still apply when this repository
> is used inside a larger workspace.

## What this project is

Self-hosted Telegram market-timing assistant for forex, equities, crypto,
precious metals, and indices.

**Production runtime:** TypeScript 5.9 · Cloudflare Workers · D1 · Zod · Vitest
· Biome. Telegram uses an authenticated webhook. Market analysis and digest run
as Cloudflare cron triggers.

**Reference/research runtime:** Python 3.12 in `src/` with the original scoring
implementation and walk-forward backtest. It is not the production bot.

## Source of truth

- `worker/src/` — production behavior.
- `worker/migrations/` — D1 schema and data migrations.
- `worker/tests/` — unit, parity, and Worker-runtime integration contracts.
- `src/` + `tests/` — Python reference and backtest regression suite.
- `README.md` / `README.en.md` — public product and self-hosting documentation.

Do not infer current behavior from the disabled legacy Python workflows.

## Runtime flow

1. `POST /telegram` validates the Telegram webhook secret and dispatches
   commands/callbacks asynchronously.
2. `0 * * * *` analyzes every active asset: market-hours check → provider fetch
   → direction-aware score → gating → subscriber broadcast → D1 state.
3. Two DST-covering cron entries generate the Madrid morning digest.
4. Freshness and quota cron jobs detect stale analysis and reset daily counters.

Provider routing lives in `worker/src/analyze/providers/index.ts`:

- forex, US stocks, indices → Twelve Data;
- MOEX stocks → MOEX ISS;
- precious metals → Yahoo Finance;
- crypto → Coinbase Exchange.

## Invariants

1. **UTC inside, local time at the display boundary.** Current display timezone
   is `Europe/Madrid`.
2. **Scoring stays explainable and direction-aware.** `buy` and `sell` share one
   implementation in `worker/src/analyze/scoring.ts`.
3. **One gate decides whether to alert.** Do not duplicate regime/cooldown/edge/
   blackout logic outside `worker/src/analyze/gating.ts`.
4. **Provider failures must not overwrite the last good analysis.** Preserve
   timeout/retry and freshness semantics.
5. **D1 is production state.** Never add runtime users, Telegram identifiers,
   conversions, or alert history to git.
6. **Secrets are env bindings.** `TELEGRAM_BOT_TOKEN`,
   `TELEGRAM_WEBHOOK_SECRET`, and `TWELVEDATA_API_KEY` must never be logged or
   committed.
7. **Webhook authentication stays fail-closed.** Secret validation happens
   before parsing or dispatch.
8. **Per-asset and per-direction cooldown state is atomic with alert history.**
   Preserve the D1 batch in `appendAlertForAsset`.
9. **Do not expand the stored provider CHECK casually.** Metals and crypto are
   runtime-routed; rebuilding `assets` can cascade through subscriptions and
   `asset_state`.
10. **The free-tier safety caps are deliberate:** 10 subscriptions per user and
    15 globally active assets.

## Verification

From `worker/`:

```bash
npm test
npm run typecheck
npm run lint
npm run test:integration  # Miniflare + D1 in the Workers runtime
```

From the repository root for the Python reference:

```bash
pytest
ruff check src tests
```

Use the workspace heavy-test slot for full suites. Do not call a documentation
or configuration change complete without at least the TypeScript gate and a
review of the generated README links.

## Deployment boundaries

- Push requires explicit user approval under workspace rules.
- `deploy-worker.yml` deploys only from `main` when Cloudflare secrets exist.
- A green CI run is not enough to claim production success: confirm migration,
  deploy, `/health`, and a real scheduled analyze tick.
- The public repository is self-hosted source, not a link to the author's live
  bot. Keep production identifiers and historical Actions data private.

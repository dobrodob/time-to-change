/**
 * Worker entry — fetch (HTTP) + scheduled (cron) handlers.
 *
 * Routes:
 *   POST /telegram → webhook handler (см. telegram/webhook.ts)
 *   GET  /health   → liveness JSON (см. lib/health.ts)
 *   *              → 404
 *
 * Cron triggers (точные строки в wrangler.toml [triggers].crons):
 *   analyze    — каждый час в 0-ю минуту UTC
 *   digest     — 9:25 и 10:25 UTC (CEST + CET windows для Madrid 11:25)
 *   freshness  — каждые 3 часа в 15-ю минуту UTC (offset от analyze tick)
 *
 * event.cron возвращает буквальную строку из конфига — поэтому два digest
 * entries матчатся раздельно (combined-форма не сматчилась бы).
 */
import { runAnalyze } from "./analyze/job";
import { runDigest } from "./digest/job";
import { validateEnv } from "./env";
import { handleHealth } from "./lib/health";
import { log } from "./lib/log";
import { runFreshnessCheck } from "./monitor/freshness";
import { runQuotaReset } from "./monitor/quota";
import { handleWebhook } from "./telegram/webhook";

export default {
  async fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> {
    let validated: ReturnType<typeof validateEnv>;
    try {
      validated = validateEnv(env);
    } catch (err) {
      log("error", "env_invalid", { error: String(err).slice(0, 300) });
      return new Response("env invalid", { status: 500 });
    }
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/telegram") {
      return handleWebhook(request, validated, ctx);
    }
    if (request.method === "GET" && url.pathname === "/health") {
      return handleHealth(validated);
    }
    return new Response("Not found", { status: 404 });
  },

  async scheduled(event: ScheduledEvent, env: unknown, ctx: ExecutionContext): Promise<void> {
    let validated: ReturnType<typeof validateEnv>;
    try {
      validated = validateEnv(env);
    } catch (err) {
      log("error", "scheduled_env_invalid", { error: String(err).slice(0, 300) });
      return;
    }
    const cron = event.cron;
    log("info", "scheduled_trigger", { cron });
    if (cron === "0 * * * *") {
      ctx.waitUntil(runAnalyze(validated));
    } else if (cron === "25 9 * * *" || cron === "25 10 * * *") {
      ctx.waitUntil(runDigest(validated));
    } else if (cron === "15 */3 * * *") {
      ctx.waitUntil(runFreshnessCheck(validated));
    } else if (cron === "1 0 * * *") {
      ctx.waitUntil(runQuotaReset(validated));
    } else {
      log("warn", "unknown_cron", { cron });
    }
  },
};

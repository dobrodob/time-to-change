#!/usr/bin/env node
/**
 * D1 → legacy state.json (schema v3) exporter. Использовать при rollback
 * с CF Worker обратно на Python polling.
 *
 * После migration 0005 поля baseline_*, quota_*, consecutive_failures,
 * last_alert_json, last_score_breakdown_json удалены из bot_state. Этот скрипт
 * читает их из asset_state (per primary asset 'EUR/USD') + alert_history. Для
 * других assets (multi-asset cut-over) export может быть неполным —
 * Python rollback не поддерживает multi-asset, потеря данных для не-EUR/USD
 * подписок ожидаема (subscriptions + assets таблицы тоже не экспортируются).
 *
 * Usage:
 *   wrangler d1 execute euro-dollar-bot-state --remote --json \
 *     --command "SELECT * FROM bot_state WHERE id=1" > /tmp/state.bot.json
 *   wrangler d1 execute euro-dollar-bot-state --remote --json \
 *     --command "SELECT * FROM users" > /tmp/state.users.json
 *   wrangler d1 execute euro-dollar-bot-state --remote --json \
 *     --command "SELECT * FROM alert_history WHERE symbol='EUR/USD' ORDER BY ts DESC LIMIT 30" > /tmp/state.alerts.json
 *   wrangler d1 execute euro-dollar-bot-state --remote --json \
 *     --command "SELECT * FROM conversions ORDER BY ts" > /tmp/state.conv.json
 *   wrangler d1 execute euro-dollar-bot-state --remote --json \
 *     --command "SELECT * FROM asset_state WHERE symbol='EUR/USD'" > /tmp/state.asset.json
 *   node scripts/d1-to-state-json.mjs /tmp/state.bot.json /tmp/state.users.json \
 *     /tmp/state.alerts.json /tmp/state.conv.json /tmp/state.asset.json > state.json
 *
 * Output: state.json в формате Python schema_version=3.
 */
import { readFileSync } from "node:fs";
import { argv, exit, stderr, stdout } from "node:process";

function readJson(path) {
  const raw = readFileSync(path, "utf-8");
  const parsed = JSON.parse(raw);
  // wrangler d1 execute --json возвращает массив со структурой [{ results, success, meta }, ...]
  if (Array.isArray(parsed) && parsed.length > 0 && Array.isArray(parsed[0].results)) {
    return parsed[0].results;
  }
  return parsed;
}

function boolFromInt(n) {
  return n === 1;
}

function main() {
  const [botPath, usersPath, alertsPath, convPath, assetPath] = argv.slice(2);
  if (!botPath || !usersPath || !alertsPath || !convPath || !assetPath) {
    stderr.write(
      "Usage: d1-to-state-json.mjs bot_state.json users.json alerts.json conversions.json asset_state.json\n",
    );
    exit(1);
  }
  const botRows = readJson(botPath);
  const userRows = readJson(usersPath);
  const alertRows = readJson(alertsPath);
  const convRows = readJson(convPath);
  const assetRows = readJson(assetPath);

  if (botRows.length === 0) {
    stderr.write("bot_state empty\n");
    exit(1);
  }
  const bot = botRows[0];
  // asset_state row для EUR/USD — primary asset. Может быть пуст если cut-over
  // ещё не произошёл; тогда baseline/quota/breakdown = null.
  const asset = assetRows.length > 0 ? assetRows[0] : null;

  // last_alert — из последнего alert_history row (alertRows[0] т.к. ORDER BY ts DESC).
  const lastAlert =
    alertRows.length > 0
      ? {
          ts: alertRows[0].ts,
          regime: alertRows[0].regime,
          score: alertRows[0].score,
          rate: alertRows[0].rate,
          edge_pct: alertRows[0].edge_pct,
        }
      : null;

  const lastScore =
    asset?.last_score_breakdown_json !== null && asset?.last_score_breakdown_json !== undefined
      ? JSON.parse(asset.last_score_breakdown_json)
      : null;

  const users = userRows.map((u) => ({
    chat_id: u.chat_id,
    role: u.role,
    name: u.name,
    joined_at: u.joined_at,
    silence: {
      active: boolFromInt(u.silence_active),
      until: u.silence_until,
      reason: u.silence_reason,
    },
    quiet: {
      enabled: boolFromInt(u.quiet_enabled),
      from_hour: u.quiet_from_hour,
      to_hour: u.quiet_to_hour,
    },
    digest_enabled: boolFromInt(u.digest_enabled),
  }));

  const state = {
    schema_version: 3,
    updated_at: new Date().toISOString(),
    telegram: {
      last_update_id: bot.last_update_id,
      users,
      menu_set_at: bot.menu_set_at,
      menu_commands_count: bot.menu_commands_count,
    },
    last_alert: lastAlert,
    alert_history_30d: alertRows.map((a) => ({
      ts: a.ts,
      regime: a.regime,
      score: a.score,
      rate: a.rate,
      edge_pct: a.edge_pct,
    })),
    baseline: {
      rolling_median_30d: asset?.baseline_rolling_median_30d ?? null,
      rolling_p90_90d: asset?.baseline_rolling_p90_90d ?? null,
      computed_at: asset?.baseline_computed_at ?? null,
    },
    quota: {
      twelvedata_credits_used_today: asset?.quota_credits_today ?? 0,
      reset_at: null, // bot_state.quota_reset_at удалён; asset_state не tracks reset_at.
    },
    consecutive_failures: 0, // dead concept after multi-asset migration; placeholder.
    budget: {
      target_eur: bot.budget_target_eur,
      deadline: bot.budget_deadline,
      started_at: bot.budget_started_at,
      converted_eur: bot.budget_converted_eur,
      converted_usd: bot.budget_converted_usd,
      history: convRows.map((c) => ({
        ts: c.ts,
        eur: c.eur,
        rate: c.rate,
        pct_at_alert: c.pct_at_alert,
      })),
    },
    last_score_breakdown: lastScore,
    last_digest_at: bot.last_digest_at,
  };

  stdout.write(JSON.stringify(state, null, 2));
}

main();

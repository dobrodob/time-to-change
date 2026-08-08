import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
/**
 * Integration tests для StateRepo через Miniflare D1.
 *
 * Запускается в CI Linux (workerd binary), локально на Windows native не
 * работает — используй WSL или просто полагайся на CI.
 *
 * Команда: `npm run test:integration`
 */
import migration0001Sql from "../../migrations/0001_initial.sql?raw";
import migration0002Sql from "../../migrations/0002_seed_events.sql?raw";
import migration0003Sql from "../../migrations/0003_multi_asset.sql?raw";
import migration0004Sql from "../../migrations/0004_seed_eur_usd_and_subscriptions.sql?raw";
import migration0005Sql from "../../migrations/0005_drop_deprecated_bot_state_columns.sql?raw";
import migration0006Sql from "../../migrations/0006_reclass_metals_commodity.sql?raw";
import { StateRepo } from "../../src/state/repo";

/**
 * Strip `--` comments (whole-line И inline-после-кода) + split на отдельные
 * statement'ы для D1 `exec()`. CRLF/LF safe. `exec()` принимает один statement
 * за раз и спотыкается на комментариях, особенно если после .join('\n')
 * inline-комментарий «съедает» остаток SQL.
 */
function splitStatements(sql: string): string[] {
  const stripped = sql
    .split(/\r?\n/)
    .map((line) => {
      const idx = line.indexOf("--");
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join(" ");
  return stripped
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function applyMigration(sql: string): Promise<void> {
  for (const stmt of splitStatements(sql)) {
    await env.DB.exec(stmt);
  }
}

beforeAll(async () => {
  // Full migration chain 0001 → 0005 — reflects production D1 state. 0004 seeds
  // EUR/USD asset + auto-subscribes existing users (см. migration 0004); tests
  // должны cleanup эти rows в beforeEach если они влияют.
  await applyMigration(migration0001Sql);
  await applyMigration(migration0002Sql);
  await applyMigration(migration0003Sql);
  await applyMigration(migration0004Sql);
  await applyMigration(migration0005Sql);
  await applyMigration(migration0006Sql);
});

beforeEach(async () => {
  // Clean slate per test (except bot_state singleton which we re-seed).
  // Order matters для FK CASCADE: subscriptions → assets, asset_state → assets.
  await env.DB.prepare("DELETE FROM subscriptions").run();
  await env.DB.prepare("DELETE FROM asset_state").run();
  await env.DB.prepare("DELETE FROM assets").run();
  await env.DB.prepare("DELETE FROM users").run();
  await env.DB.prepare("DELETE FROM alert_history").run();
  await env.DB.prepare("DELETE FROM conversions").run();
  await env.DB.prepare("DELETE FROM events").run();
  await env.DB.prepare(
    `UPDATE bot_state
       SET last_update_id = 0, menu_set_at = NULL, menu_commands_count = 0,
           last_digest_at = NULL,
           budget_target_eur = NULL, budget_deadline = NULL, budget_started_at = NULL,
           budget_converted_eur = 0, budget_converted_usd = 0
       WHERE id = 1`,
  ).run();
});

describe("StateRepo / assets — inactive-on-create + subscribeAndActivate (orphan-fix)", () => {
  const metal = {
    symbol: "XAG/USD",
    display_name: "Серебро",
    type: "commodity" as const,
    provider: "twelvedata" as const,
    currency: "USD",
  };

  it("upsertAsset создаёт актив НЕактивным (active=false) — не плодит сирот", async () => {
    const repo = new StateRepo(env.DB);
    const a = await repo.upsertAsset(metal);
    expect(a.active).toBe(false);
    expect(await repo.listActiveAssets()).toHaveLength(0);
  });

  it("subscribeAndActivate атомарно создаёт подписку И активирует актив", async () => {
    const repo = new StateRepo(env.DB);
    await repo.addUser({ chat_id: 111, role: "owner" });
    await repo.upsertAsset(metal);
    await repo.subscribeAndActivate(111, "XAG/USD", "sell");
    expect((await repo.getAsset("XAG/USD"))?.active).toBe(true);
    expect(await repo.listActiveAssets()).toHaveLength(1);
    expect(await repo.getSubscription(111, "XAG/USD", "sell")).not.toBeNull();
  });

  it("upsertAsset на уже активный актив НЕ деактивирует (ON CONFLICT keeps active)", async () => {
    const repo = new StateRepo(env.DB);
    await repo.addUser({ chat_id: 111, role: "owner" });
    await repo.upsertAsset(metal);
    await repo.subscribeAndActivate(111, "XAG/USD", "sell");
    await repo.upsertAsset({ ...metal, display_name: "Серебро (обновл.)" });
    const a = await repo.getAsset("XAG/USD");
    expect(a?.active).toBe(true);
    expect(a?.display_name).toBe("Серебро (обновл.)");
  });

  it("orphan lifecycle: subscribeAndActivate → unsubscribe → deactivateAssetIfOrphan → inactive", async () => {
    const repo = new StateRepo(env.DB);
    await repo.addUser({ chat_id: 111, role: "owner" });
    await repo.upsertAsset(metal);
    await repo.subscribeAndActivate(111, "XAG/USD", "sell");
    expect((await repo.getAsset("XAG/USD"))?.active).toBe(true);
    await repo.removeSubscription(111, "XAG/USD", "sell");
    expect(await repo.deactivateAssetIfOrphan("XAG/USD")).toBe(true);
    expect(await repo.listActiveAssets()).toHaveLength(0);
  });
});

describe("StateRepo / resetAllQuota (суточный сброс квоты)", () => {
  it("обнуляет quota_credits_today по всем активам + возвращает кол-во затронутых", async () => {
    const repo = new StateRepo(env.DB);
    await repo.upsertAsset({
      symbol: "EUR/USD",
      display_name: "x",
      type: "forex",
      provider: "twelvedata",
      currency: "USD",
    });
    await repo.upsertAsset({
      symbol: "AAPL",
      display_name: "x",
      type: "stock_us",
      provider: "twelvedata",
      currency: "USD",
    });
    await repo.bumpAssetQuota("EUR/USD", 50);
    await repo.bumpAssetQuota("AAPL", 30);
    expect(await repo.getTotalAssetQuotaToday()).toBe(80);

    expect(await repo.resetAllQuota()).toBe(2); // обе строки были != 0
    expect(await repo.getTotalAssetQuotaToday()).toBe(0);
    expect(await repo.resetAllQuota()).toBe(0); // уже 0 — нечего обнулять
  });
});

describe("StateRepo / users", () => {
  it("addUser + getUser roundtrip", async () => {
    const repo = new StateRepo(env.DB);
    await repo.addUser({ chat_id: 100, role: "owner", name: "Test" });
    const u = await repo.getUser(100);
    expect(u?.chat_id).toBe(100);
    expect(u?.role).toBe("owner");
    expect(u?.name).toBe("Test");
    expect(u?.silence_active).toBe(false);
    expect(u?.digest_enabled).toBe(true);
  });

  it("getOwner returns null when no users", async () => {
    const repo = new StateRepo(env.DB);
    expect(await repo.getOwner()).toBeNull();
  });

  it("getOwner returns owner row when one exists", async () => {
    const repo = new StateRepo(env.DB);
    await repo.addUser({ chat_id: 100, role: "owner", name: "K" });
    await repo.addUser({ chat_id: 200, role: "member", name: "M" });
    const owner = await repo.getOwner();
    expect(owner?.chat_id).toBe(100);
  });

  it("addUser on existing chat_id is idempotent — keeps existing role", async () => {
    const repo = new StateRepo(env.DB);
    await repo.addUser({ chat_id: 100, role: "owner", name: "K" });
    const u2 = await repo.addUser({ chat_id: 100, role: "member", name: "K2" });
    expect(u2.role).toBe("owner"); // role NOT downgraded
  });

  it("removeUser", async () => {
    const repo = new StateRepo(env.DB);
    await repo.addUser({ chat_id: 100, role: "member" });
    expect(await repo.removeUser(100)).toBe(true);
    expect(await repo.getUser(100)).toBeNull();
    expect(await repo.removeUser(100)).toBe(false); // already gone
  });

  it("listUsers + countUsers", async () => {
    const repo = new StateRepo(env.DB);
    await repo.addUser({ chat_id: 100, role: "owner" });
    await repo.addUser({ chat_id: 200, role: "member" });
    await repo.addUser({ chat_id: 300, role: "member" });
    expect(await repo.countUsers()).toBe(3);
    const list = await repo.listUsers();
    expect(list).toHaveLength(3);
  });

  it("updateUserSilence persists", async () => {
    const repo = new StateRepo(env.DB);
    await repo.addUser({ chat_id: 100, role: "owner" });
    await repo.updateUserSilence(100, true, "2026-05-20T00:00:00Z", "manual");
    const u = await repo.getUser(100);
    expect(u?.silence_active).toBe(true);
    expect(u?.silence_until).toBe("2026-05-20T00:00:00Z");
    expect(u?.silence_reason).toBe("manual");
  });

  it("updateUserQuiet persists", async () => {
    const repo = new StateRepo(env.DB);
    await repo.addUser({ chat_id: 100, role: "owner" });
    await repo.updateUserQuiet(100, true, 22, 8);
    const u = await repo.getUser(100);
    expect(u?.quiet_enabled).toBe(true);
    expect(u?.quiet_from_hour).toBe(22);
    expect(u?.quiet_to_hour).toBe(8);
  });

  it("setDigestEnabled toggles", async () => {
    const repo = new StateRepo(env.DB);
    await repo.addUser({ chat_id: 100, role: "owner" });
    await repo.setDigestEnabled(100, false);
    expect((await repo.getUser(100))?.digest_enabled).toBe(false);
    await repo.setDigestEnabled(100, true);
    expect((await repo.getUser(100))?.digest_enabled).toBe(true);
  });

  it("expireSilencesIfDue expires past silences", async () => {
    const repo = new StateRepo(env.DB);
    await repo.addUser({ chat_id: 100, role: "owner" });
    await repo.addUser({ chat_id: 200, role: "member" });
    await repo.updateUserSilence(100, true, "2026-01-01T00:00:00Z", "manual"); // past
    await repo.updateUserSilence(200, true, "2099-01-01T00:00:00Z", "manual"); // future
    const expired = await repo.expireSilencesIfDue("2026-05-12T00:00:00Z");
    expect(expired).toBe(1);
    expect((await repo.getUser(100))?.silence_active).toBe(false);
    expect((await repo.getUser(200))?.silence_active).toBe(true);
  });
});

describe("StateRepo / bot_state singleton", () => {
  it("getBotState returns initialized row", async () => {
    const repo = new StateRepo(env.DB);
    const s = await repo.getBotState();
    // Migration 0005 bumps schema_version 4 → 5 (deprecated columns dropped).
    expect(s.schema_version).toBe(5);
    expect(s.last_update_id).toBe(0);
    expect(s.budget_converted_eur).toBe(0);
  });

  it("updateLastUpdateId monotonic (MAX)", async () => {
    const repo = new StateRepo(env.DB);
    await repo.updateLastUpdateId(100);
    await repo.updateLastUpdateId(50); // older — should NOT override
    expect((await repo.getBotState()).last_update_id).toBe(100);
    await repo.updateLastUpdateId(200);
    expect((await repo.getBotState()).last_update_id).toBe(200);
  });

  // Тесты на dead writers (setBaseline / setQuota / bumpQuotaCredits / setLastScoreBreakdown)
  // удалены вместе с методами и колонками в migration 0005 (PR #24).
  // Эквивалент через asset_state — в отдельном suite, когда расширим test-infra для
  // multi-asset (apply migrations 0003+0004 в beforeAll).
});

describe("StateRepo / alert history", () => {
  // Helper для прямого INSERT в alert_history — заменяет dead repo.appendAlert.
  // Новые alerts пишутся через repo.appendAlertForAsset (требует asset_state).
  async function insertAlert(
    db: D1Database,
    ts: string,
    rate: number,
    score = 75,
    regime = "partial",
    edge_pct = 2,
  ): Promise<void> {
    await db
      .prepare(
        "INSERT INTO alert_history (ts, regime, score, rate, edge_pct) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(ts, regime, score, rate, edge_pct)
      .run();
  }

  it("getRecentAlerts returns DESC by ts", async () => {
    const repo = new StateRepo(env.DB);
    await insertAlert(env.DB, "2026-05-10T10:00:00Z", 1.18, 70);
    await insertAlert(env.DB, "2026-05-12T10:00:00Z", 1.19, 80);
    await insertAlert(env.DB, "2026-05-11T10:00:00Z", 1.17, 75);
    const recent = await repo.getRecentAlerts(2);
    expect(recent[0].ts).toBe("2026-05-12T10:00:00Z");
    expect(recent[1].ts).toBe("2026-05-11T10:00:00Z");
  });

  it("getLastAlertTs returns latest ts or null", async () => {
    const repo = new StateRepo(env.DB);
    expect(await repo.getLastAlertTs()).toBeNull();
    await insertAlert(env.DB, "2026-05-10T10:00:00Z", 1.18, 70, "p", 2);
    expect(await repo.getLastAlertTs()).toBe("2026-05-10T10:00:00Z");
  });
});

describe("StateRepo / budget", () => {
  it("setBudget initializes, addConversion accumulates", async () => {
    const repo = new StateRepo(env.DB);
    await repo.setBudget(6000, "2026-06-12T00:00:00Z", "2026-05-12T00:00:00Z");
    await repo.addConversion({
      ts: "2026-05-13T10:00:00Z",
      eur: 1500,
      rate: 1.0852,
      pct_at_alert: 30,
    });
    const s = await repo.getBotState();
    expect(s.budget_target_eur).toBe(6000);
    expect(s.budget_converted_eur).toBe(1500);
    expect(s.budget_converted_usd).toBeCloseTo(1500 * 1.0852);
    const list = await repo.listConversions();
    expect(list).toHaveLength(1);
  });

  it("cancelBudget clears state + conversions", async () => {
    const repo = new StateRepo(env.DB);
    await repo.setBudget(6000, "2026-06-12T00:00:00Z", "2026-05-12T00:00:00Z");
    await repo.addConversion({
      ts: "2026-05-13T10:00:00Z",
      eur: 1500,
      rate: 1.0852,
      pct_at_alert: 30,
    });
    await repo.cancelBudget();
    const s = await repo.getBotState();
    expect(s.budget_target_eur).toBeNull();
    expect(s.budget_converted_eur).toBe(0);
    expect(await repo.listConversions()).toHaveLength(0);
  });
});

describe("StateRepo / events", () => {
  it("getUpcomingEvent returns nearest future event", async () => {
    const repo = new StateRepo(env.DB);
    await env.DB.prepare(
      "INSERT INTO events (ts, type, description) VALUES ('2026-06-01T18:00:00Z', 'FOMC', 'Rate decision')",
    ).run();
    await env.DB.prepare(
      "INSERT INTO events (ts, type, description) VALUES ('2026-07-01T18:00:00Z', 'ECB', NULL)",
    ).run();
    const upcoming = await repo.getUpcomingEvent("2026-05-12T00:00:00Z");
    expect(upcoming?.type).toBe("FOMC");
    expect(upcoming?.description).toBe("Rate decision");
  });

  it("listEventsInRange filters by ts BETWEEN", async () => {
    const repo = new StateRepo(env.DB);
    await env.DB.prepare(
      "INSERT INTO events (ts, type, description) VALUES ('2026-06-01T18:00:00Z', 'FOMC', NULL)",
    ).run();
    await env.DB.prepare(
      "INSERT INTO events (ts, type, description) VALUES ('2026-08-01T18:00:00Z', 'ECB', NULL)",
    ).run();
    const inRange = await repo.listEventsInRange("2026-05-01T00:00:00Z", "2026-07-01T00:00:00Z");
    expect(inRange).toHaveLength(1);
    expect(inRange[0].type).toBe("FOMC");
  });
});

describe("StateRepo / CHECK constraints", () => {
  it("rejects role not in (owner, member)", async () => {
    await expect(
      env.DB.prepare(
        "INSERT INTO users (chat_id, role, joined_at) VALUES (1, 'admin', '2026-01-01T00:00:00Z')",
      ).run(),
    ).rejects.toThrow();
  });

  it("rejects quiet_from_hour > 23", async () => {
    await expect(
      env.DB.prepare(
        "INSERT INTO users (chat_id, role, joined_at, quiet_from_hour) VALUES (1, 'member', '2026-01-01T00:00:00Z', 24)",
      ).run(),
    ).rejects.toThrow();
  });

  it("bot_state singleton — second row rejected", async () => {
    await expect(env.DB.prepare("INSERT INTO bot_state (id) VALUES (2)").run()).rejects.toThrow();
  });
});

describe("StateRepo / asset_state (multi-asset)", () => {
  async function seedAsset(symbol = "EUR/USD") {
    await env.DB.prepare(
      `INSERT INTO assets (symbol, display_name, type, provider, currency, active, added_at)
       VALUES (?, ?, 'forex', 'twelvedata', 'USD', 1, '2026-05-12T12:00:00Z')`,
    )
      .bind(symbol, symbol)
      .run();
  }

  it("getPrimaryAssetState — null если EUR/USD row отсутствует", async () => {
    const repo = new StateRepo(env.DB);
    expect(await repo.getPrimaryAssetState()).toBeNull();
  });

  it("getPrimaryAssetState — возвращает asset_state после setAssetBaseline", async () => {
    const repo = new StateRepo(env.DB);
    await seedAsset();
    await repo.setAssetBaseline("EUR/USD", 1.17, 1.18, 1.16, "2026-05-14T14:00:00Z");
    const s = await repo.getPrimaryAssetState();
    expect(s).not.toBeNull();
    expect(s?.baseline_rolling_median_30d).toBe(1.17);
    expect(s?.baseline_rolling_p90_90d).toBe(1.18);
    expect(s?.baseline_rolling_p10_90d).toBe(1.16);
  });

  it("setAssetLastScoreBreakdown — roundtrip через JSON", async () => {
    const repo = new StateRepo(env.DB);
    await seedAsset();
    const breakdown = {
      ts: "2026-05-14T14:00:00Z",
      score: 75.5,
      regime: "partial",
      rate: 1.18,
      edge_pct: 2.5,
      components: {
        trend_daily: 100,
        timing_hourly: 60,
        extremes: 30,
        volatility: 100,
        historical: 75,
      },
      notes: ["golden cross"],
      was_alert: true,
      gate_reason: null,
    };
    await repo.setAssetLastScoreBreakdown("EUR/USD", breakdown);
    const s = await repo.getAssetState("EUR/USD");
    expect(s?.last_score_breakdown).toEqual(breakdown);
  });

  it("bumpAssetQuota + getTotalAssetQuotaToday — sum across assets", async () => {
    const repo = new StateRepo(env.DB);
    await seedAsset("EUR/USD");
    await seedAsset("AAPL");
    expect(await repo.getTotalAssetQuotaToday()).toBe(0);
    await repo.bumpAssetQuota("EUR/USD", 9);
    await repo.bumpAssetQuota("EUR/USD", 9);
    await repo.bumpAssetQuota("AAPL", 5);
    expect(await repo.getTotalAssetQuotaToday()).toBe(23);
  });

  it("appendAlertForAsset — пишет alert_history + asset_state.last_alert_*", async () => {
    const repo = new StateRepo(env.DB);
    await seedAsset();
    const alert = {
      ts: "2026-05-14T14:00:00Z",
      regime: "partial",
      score: 78,
      rate: 1.18,
      edge_pct: 3,
    };
    await repo.appendAlertForAsset("EUR/USD", "sell", alert);
    const recent = await repo.getRecentAlerts(5);
    expect(recent).toHaveLength(1);
    // AlertRecord теперь включает symbol + direction (optional, nullable для
    // legacy pre-cut-over rows). Проверяем поэлементно вместо deep equal.
    expect(recent[0].ts).toBe(alert.ts);
    expect(recent[0].regime).toBe(alert.regime);
    expect(recent[0].score).toBe(alert.score);
    expect(recent[0].rate).toBe(alert.rate);
    expect(recent[0].edge_pct).toBe(alert.edge_pct);
    expect(recent[0].symbol).toBe("EUR/USD");
    expect(recent[0].direction).toBe("sell");
    const s = await repo.getAssetState("EUR/USD");
    expect(s?.last_alert_sell_ts).toBe(alert.ts);
    expect(s?.last_alert_sell_regime).toBe("partial");
    expect(s?.last_alert_sell_score).toBe(78);
    // buy direction нетронут
    expect(s?.last_alert_buy_ts).toBeNull();
  });
});

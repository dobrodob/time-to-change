import { describe, expect, it } from "vitest";
import { collectStaleAssets, evaluateFreshness } from "../../src/monitor/freshness";
import type { Asset, AssetState, AssetType, LastScoreBreakdown } from "../../src/state/schema";

function makeForexAsset(symbol = "EUR/USD"): Asset {
  return {
    symbol,
    display_name: symbol,
    type: "forex",
    provider: "twelvedata",
    currency: "USD",
    active: true,
    added_at: "2026-05-12T12:00:00Z",
  };
}

function makeBreakdown(ts: string): LastScoreBreakdown {
  return {
    ts,
    score: 50,
    regime: "cooldown",
    rate: 1.17,
    edge_pct: 0,
    components: {
      trend_daily: 50,
      timing_hourly: 50,
      extremes: 50,
      volatility: 50,
      historical: 50,
    },
    notes: [],
    was_alert: false,
    gate_reason: null,
  };
}

function makeAssetState(breakdownTs: string | null): AssetState {
  return {
    symbol: "EUR/USD",
    baseline_rolling_median_30d: 1.17,
    baseline_rolling_p90_90d: 1.18,
    baseline_rolling_p10_90d: 1.16,
    baseline_computed_at: "2026-05-14T12:00:00Z",
    last_alert_sell_ts: null,
    last_alert_sell_regime: null,
    last_alert_sell_score: null,
    last_alert_buy_ts: null,
    last_alert_buy_regime: null,
    last_alert_buy_score: null,
    last_score_breakdown: breakdownTs !== null ? makeBreakdown(breakdownTs) : null,
    quota_credits_today: 0,
  };
}

// 2026-05-14 — Thursday, forex market OPEN.
const THU_14_UTC = "2026-05-14T14:00:00Z";
// 2026-05-16 — Saturday, forex CLOSED.
const SAT_12_UTC = "2026-05-16T12:00:00Z";

describe("evaluateFreshness", () => {
  it("asset=null → no_alert / no_asset (нет primary asset, ничего не делаем)", () => {
    const d = evaluateFreshness(null, null, THU_14_UTC);
    expect(d.alert).toBe(false);
    expect(d.reason).toBe("no_asset");
    expect(d.freshness_seconds).toBeNull();
  });

  it("forex market closed (Saturday) → no_alert / market_closed", () => {
    // На weekend staleness ожидаема — analyze пропускает закрытый рынок.
    const d = evaluateFreshness(makeForexAsset(), makeAssetState(null), SAT_12_UTC);
    expect(d.alert).toBe(false);
    expect(d.reason).toBe("market_closed");
  });

  it("market open, old state=null → alert / never_analyzed", () => {
    const d = evaluateFreshness(makeForexAsset(), null, THU_14_UTC);
    expect(d.alert).toBe(true);
    expect(d.reason).toBe("never_analyzed");
    expect(d.freshness_seconds).toBeGreaterThan(7200);
  });

  it("market open, newly added breakdown missing → grace period without alert", () => {
    const recent = { ...makeForexAsset(), added_at: "2026-05-14T13:30:00Z" };
    const d = evaluateFreshness(recent, makeAssetState(null), THU_14_UTC);
    expect(d.alert).toBe(false);
    expect(d.reason).toBe("never_analyzed");
    expect(d.freshness_seconds).toBe(1800);
  });

  it("fresh (1 час назад, threshold 2h) → no_alert / fresh", () => {
    const d = evaluateFreshness(
      makeForexAsset(),
      makeAssetState("2026-05-14T13:00:00Z"),
      THU_14_UTC,
    );
    expect(d.alert).toBe(false);
    expect(d.reason).toBe("fresh");
    expect(d.freshness_seconds).toBe(3600);
  });

  it("ровно на threshold (2h) → no_alert / fresh (edge case: <=)", () => {
    const d = evaluateFreshness(
      makeForexAsset(),
      makeAssetState("2026-05-14T12:00:00Z"),
      THU_14_UTC,
      7200,
    );
    expect(d.alert).toBe(false);
    expect(d.reason).toBe("fresh");
    expect(d.freshness_seconds).toBe(7200);
  });

  it("stale (3h, threshold 2h) → ALERT / stale", () => {
    const d = evaluateFreshness(
      makeForexAsset(),
      makeAssetState("2026-05-14T11:00:00Z"),
      THU_14_UTC,
    );
    expect(d.alert).toBe(true);
    expect(d.reason).toBe("stale");
    expect(d.freshness_seconds).toBe(10800);
  });

  it("сценарий PR #23 (frozen 38h) → ALERT / stale (что и закрыли)", () => {
    const d = evaluateFreshness(
      makeForexAsset(),
      makeAssetState("2026-05-12T13:00:56Z"), // фактический ts из /health snapshot до фикса
      THU_14_UTC,
    );
    expect(d.alert).toBe(true);
    expect(d.reason).toBe("stale");
    // ~177ч, главное что > threshold
    expect(d.freshness_seconds).toBeGreaterThan(7200);
  });

  it("custom threshold (например 4h) — конфигурируется", () => {
    // 3 часа назад, threshold 4h → fresh.
    const d = evaluateFreshness(
      makeForexAsset(),
      makeAssetState("2026-05-14T11:00:00Z"),
      THU_14_UTC,
      14400,
    );
    expect(d.alert).toBe(false);
    expect(d.reason).toBe("fresh");
  });
});

describe("collectStaleAssets — мониторинг ВСЕХ активов, не только EUR/USD", () => {
  function entry(symbol: string, type: AssetType, breakdownTs: string | null) {
    return {
      asset: { ...makeForexAsset(symbol), type },
      state: breakdownTs !== null ? makeAssetState(breakdownTs) : null,
    };
  }

  it("выбирает протухшие и давно never_analyzed active-активы", () => {
    const out = collectStaleAssets(
      [
        entry("EUR/USD", "forex", "2026-05-14T13:30:00Z"), // 30мин — свежо
        entry("XAU/USD", "commodity", "2026-05-14T10:00:00Z"), // 4ч — stale
        entry("XAG/USD", "commodity", null), // never_analyzed — не алертим (только подписались)
      ],
      THU_14_UTC,
    );
    expect(out.map((s) => s.symbol)).toEqual(["XAU/USD", "XAG/USD"]);
    expect(out[0].freshness_seconds).toBeGreaterThan(7200);
    expect(out[0].type).toBe("commodity");
  });

  it("на закрытом рынке (Saturday) ничего не выбирает — staleness ожидаема", () => {
    const out = collectStaleAssets(
      [entry("XAU/USD", "commodity", "2026-05-10T00:00:00Z")], // очень старое, но рынок закрыт
      SAT_12_UTC,
    );
    expect(out).toHaveLength(0);
  });

  it("пустой список активов → пусто", () => {
    expect(collectStaleAssets([], THU_14_UTC)).toHaveLength(0);
  });
});

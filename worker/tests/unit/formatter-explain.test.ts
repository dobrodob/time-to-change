import { describe, expect, it } from "vitest";
import { formatExplain } from "../../src/commands/formatter";
import type { Asset, AssetState, LastScoreBreakdown } from "../../src/state/schema";

function makeAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    symbol: "XAU/USD",
    display_name: "Gold Spot",
    type: "commodity",
    provider: "twelvedata",
    currency: "USD",
    active: true,
    added_at: "2026-05-24T00:00:00Z",
    ...overrides,
  };
}

function makeBreakdown(overrides: Partial<LastScoreBreakdown> = {}): LastScoreBreakdown {
  return {
    ts: "2026-05-14T12:00:00Z",
    score: 48,
    regime: "cooldown",
    rate: 1.18234,
    edge_pct: 0.1,
    components: {
      trend_daily: 50,
      timing_hourly: 40,
      extremes: 60,
      volatility: 50,
      historical: 45,
    },
    notes: [],
    was_alert: false,
    gate_reason: null,
    ...overrides,
  };
}

function makeAssetState(overrides: Partial<AssetState> = {}): AssetState {
  return {
    symbol: "EUR/USD",
    baseline_rolling_median_30d: 1.17371,
    baseline_rolling_p90_90d: 1.18073,
    baseline_rolling_p10_90d: 1.16234,
    baseline_computed_at: "2026-05-14T12:00:00Z",
    last_alert_sell_ts: null,
    last_alert_sell_regime: null,
    last_alert_sell_score: null,
    last_alert_buy_ts: null,
    last_alert_buy_regime: null,
    last_alert_buy_score: null,
    last_score_breakdown: makeBreakdown(),
    quota_credits_today: 0,
    ...overrides,
  };
}

describe("formatExplain", () => {
  it("assetState=null — placeholder про 'анализ ещё не запускался'", () => {
    expect(formatExplain(null, "UTC")).toBe("Анализ ещё не запускался — попробуй через час.");
  });

  it("assetState без breakdown — тот же placeholder", () => {
    expect(formatExplain(makeAssetState({ last_score_breakdown: null }), "UTC")).toBe(
      "Анализ ещё не запускался — попробуй через час.",
    );
  });

  it("полный breakdown — печатает rate/edge + все 5 компонент со взвешенными вкладами", () => {
    const out = formatExplain(makeAssetState(), "UTC");
    expect(out).toContain("Из чего сейчас оценка");
    expect(out).toContain("1.18234");
    expect(out).toContain("+0.10%");
    expect(out).toContain("Дневной тренд");
    expect(out).toContain("Часовой тайминг");
    expect(out).toContain("Экстремумы");
    expect(out).toContain("Волатильность");
    expect(out).toContain("Историка (60d)");
    expect(out).toContain("ждать"); // regime cooldown
  });

  it("компонент = null — печатает 'нет данных' и не учитывает в total", () => {
    const out = formatExplain(
      makeAssetState({
        last_score_breakdown: makeBreakdown({
          components: {
            trend_daily: 100,
            timing_hourly: null,
            extremes: null,
            volatility: null,
            historical: null,
          },
        }),
      }),
      "UTC",
    );
    expect(out).toContain("нет данных");
    // trend_daily=100 * 0.25 = 25. Total = 25.
    expect(out).toContain("Итого: <b>25/100</b>");
  });

  it("breakdown.notes печатается секцией 'Что повлияло'", () => {
    const out = formatExplain(
      makeAssetState({
        last_score_breakdown: makeBreakdown({ notes: ["FOMC через 2 часа", "Volatility spike"] }),
      }),
      "UTC",
    );
    expect(out).toContain("Что повлияло:");
    expect(out).toContain("FOMC через 2 часа");
    expect(out).toContain("Volatility spike");
  });

  it("was_alert=false + gate_reason — показывает причину почему алерт не отправлен", () => {
    const out = formatExplain(
      makeAssetState({
        last_score_breakdown: makeBreakdown({ was_alert: false, gate_reason: "cooldown_24h" }),
      }),
      "UTC",
    );
    expect(out).toContain("Алерт не отправлен: cooldown_24h");
  });

  it("was_alert=true — секция 'не отправлен' не появляется", () => {
    const out = formatExplain(
      makeAssetState({
        last_score_breakdown: makeBreakdown({ was_alert: true, gate_reason: null }),
      }),
      "UTC",
    );
    expect(out).not.toContain("Алерт не отправлен");
  });

  it("с asset (stock_ru) — печатает symbol в заголовке + RUB-форматирование", () => {
    const state = makeAssetState({
      symbol: "ROSN",
      last_score_breakdown: makeBreakdown({ rate: 545.5 }),
    });
    const asset = makeAsset({
      symbol: "ROSN",
      display_name: "Роснефть",
      type: "stock_ru",
      currency: "RUB",
      provider: "moex",
    });
    const out = formatExplain(state, "UTC", asset);
    expect(out).toContain("ROSN");
    expect(out).toContain("₽545.50");
  });

  it("без asset — legacy header 'Из чего сейчас оценка' (backward compat)", () => {
    const out = formatExplain(makeAssetState(), "UTC");
    expect(out).toContain("Из чего сейчас оценка");
    expect(out).not.toContain("Из чего оценка ");
  });

  // ============ Per-asset weights (hotfix post-merge review) ============

  it("без asset — печатает forex веса (0.25/0.25/0.20/0.10/0.20) + 60d window", () => {
    const out = formatExplain(makeAssetState(), "UTC");
    expect(out).toContain("× 0.25");
    expect(out).toContain("Историка (60d)"); // forex теперь 60d (news-driven)
  });

  it("stock_ru (Роснефть) — печатает stock_ru веса (0.20 trend / 0.30 timing) + 60d", () => {
    const state = makeAssetState({ symbol: "ROSN" });
    const asset = makeAsset({
      symbol: "ROSN",
      type: "stock_ru",
      currency: "RUB",
      provider: "moex",
    });
    const out = formatExplain(state, "UTC", asset);
    // stock_ru унифицирован с stock_us — timing 0.30 > trend 0.20.
    expect(out).toMatch(/Дневной тренд.*× 0\.2/);
    expect(out).toMatch(/Часовой тайминг.*× 0\.3/);
    expect(out).toContain("Историка (60d)"); // window унифицирован с stock_us
  });

  it("stock_us (AAPL) — печатает stock_us веса (0.20 trend / 0.30 timing) + 60d window", () => {
    const state = makeAssetState({ symbol: "AAPL" });
    const asset = makeAsset({
      symbol: "AAPL",
      type: "stock_us",
      currency: "USD",
      provider: "twelvedata",
    });
    const out = formatExplain(state, "UTC", asset);
    expect(out).toMatch(/Дневной тренд.*× 0\.2/);
    expect(out).toMatch(/Часовой тайминг.*× 0\.3/);
    expect(out).toContain("Историка (60d)"); // stock_us → 60d
  });

  it("crypto (BTC) — печатает crypto веса (0.15 trend / 0.35 timing) + 45d window", () => {
    const state = makeAssetState({ symbol: "BTC/USD" });
    const asset = makeAsset({
      symbol: "BTC/USD",
      type: "crypto",
      currency: "USD",
      provider: "twelvedata",
    });
    const out = formatExplain(state, "UTC", asset);
    expect(out).toMatch(/Дневной тренд.*× 0\.15/);
    expect(out).toMatch(/Часовой тайминг.*× 0\.35/);
    expect(out).toContain("Историка (45d)"); // crypto → 45d
  });

  it("contributions считаются с правильными весами (stock_ru regression check)", () => {
    // historical=80, trend_daily=100 → forex contrib = 100*0.25 + 80*0.20 = 41
    //                                   stock_ru contrib = 100*0.20 + 80*0.20 = 36
    // (stock_ru унифицирован с stock_us: trend 0.20 / hist 0.20)
    const state = makeAssetState({
      last_score_breakdown: makeBreakdown({
        components: {
          trend_daily: 100,
          timing_hourly: null,
          extremes: null,
          volatility: null,
          historical: 80,
        },
      }),
    });
    const asset = makeAsset({
      symbol: "ROSN",
      type: "stock_ru",
      currency: "RUB",
      provider: "moex",
    });
    const out = formatExplain(state, "UTC", asset);
    // forex: 41/100, stock_ru (== stock_us): 36/100.
    expect(out).toContain("Итого: <b>36/100</b>");
  });
});

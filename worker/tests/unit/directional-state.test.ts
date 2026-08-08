import { describe, expect, it } from "vitest";
import {
  scoreBreakdownForDirection,
  type AssetState,
  type LastScoreBreakdown,
} from "../../src/state/schema";

function breakdown(score: number): LastScoreBreakdown {
  return {
    ts: "2026-08-08T00:00:00Z",
    score,
    regime: "watch",
    rate: 1.1,
    edge_pct: 0,
    components: {},
    notes: [],
    was_alert: false,
    gate_reason: "regime_not_actionable",
  };
}

function state(overrides: Partial<AssetState> = {}): AssetState {
  return {
    symbol: "EUR/USD",
    baseline_rolling_median_30d: null,
    baseline_rolling_p90_90d: null,
    baseline_rolling_p10_90d: null,
    baseline_computed_at: null,
    last_alert_sell_ts: null,
    last_alert_sell_regime: null,
    last_alert_sell_score: null,
    last_alert_buy_ts: null,
    last_alert_buy_regime: null,
    last_alert_buy_score: null,
    last_score_breakdown: breakdown(50),
    quota_credits_today: 0,
    ...overrides,
  };
}

describe("directional score state", () => {
  it("uses the requested directional snapshot", () => {
    const value = state({
      last_score_breakdown_sell: breakdown(80),
      last_score_breakdown_buy: breakdown(20),
    });
    expect(scoreBreakdownForDirection(value, "sell")?.score).toBe(80);
    expect(scoreBreakdownForDirection(value, "buy")?.score).toBe(20);
  });

  it("does not reuse a sell snapshot for a missing buy snapshot", () => {
    const value = state({
      last_score_breakdown_sell: breakdown(80),
      last_score_breakdown_buy: null,
    });
    expect(scoreBreakdownForDirection(value, "buy")).toBeNull();
  });

  it("falls back to the legacy shared snapshot during rolling upgrade", () => {
    expect(scoreBreakdownForDirection(state(), "buy")?.score).toBe(50);
  });
});

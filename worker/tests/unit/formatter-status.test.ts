import { describe, expect, it } from "vitest";
import {
  formatStatus,
  formatStatusNoData,
  formatStatusNotSubscribed,
  formatStatusOverview,
} from "../../src/commands/formatter";
import type {
  Asset,
  AssetState,
  LastScoreBreakdown,
  Subscription,
  User,
} from "../../src/state/schema";

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

function makeSub(overrides: Partial<Subscription> = {}): Subscription {
  return {
    chat_id: 100,
    symbol: "XAU/USD",
    direction: "buy",
    subscribed_at: "2026-05-24T00:00:00Z",
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

function makeUser(overrides: Partial<User> = {}): User {
  return {
    chat_id: 100,
    role: "owner",
    name: "K",
    joined_at: "2026-01-01T00:00:00Z",
    silence_active: false,
    silence_until: null,
    silence_reason: null,
    quiet_enabled: false,
    quiet_from_hour: 23,
    quiet_to_hour: 7,
    digest_enabled: true,
    ...overrides,
  };
}

describe("formatStatus", () => {
  it("показывает rate / median / p90 / edge / score из assetState", () => {
    const out = formatStatus(makeAssetState(), makeUser(), "UTC");
    expect(out).toContain("Курс EUR/USD");
    expect(out).toContain("1.18234"); // свежий rate из breakdown
    expect(out).toContain("Медиана 30d: 1.17371");
    expect(out).toContain("Верх 90d: 1.18073");
    expect(out).toContain("+0.10%");
    expect(out).toContain("48/100");
    expect(out).toContain("ждать"); // regime=cooldown
  });

  it("без assetState — fallback 'данные ещё не загружены', без baseline-строк", () => {
    const out = formatStatus(null, makeUser(), "UTC");
    expect(out).toContain("Курс EUR/USD");
    expect(out).toContain("Свежие данные ещё не загружены");
    expect(out).not.toContain("Медиана 30d");
    expect(out).not.toContain("Верх 90d");
    expect(out).not.toContain("Edge:");
  });

  it("assetState без breakdown — показывает baselines, но не показывает rate/edge/score", () => {
    const out = formatStatus(makeAssetState({ last_score_breakdown: null }), makeUser(), "UTC");
    expect(out).toContain("Свежие данные ещё не загружены");
    expect(out).toContain("Медиана 30d: 1.17371");
    expect(out).toContain("Верх 90d: 1.18073");
    expect(out).not.toContain("Edge:");
    expect(out).not.toContain("Резонность");
  });

  it("baselines = null не печатаются (избегаем 'Медиана: null')", () => {
    const out = formatStatus(
      makeAssetState({
        baseline_rolling_median_30d: null,
        baseline_rolling_p90_90d: null,
      }),
      makeUser(),
      "UTC",
    );
    expect(out).not.toContain("Медиана 30d");
    expect(out).not.toContain("Верх 90d");
    // Но breakdown остался — rate/edge/score печатаются
    expect(out).toContain("1.18234");
    expect(out).toContain("+0.10%");
  });

  it("silence-блок появляется когда user.silence_active=true", () => {
    const out = formatStatus(
      makeAssetState(),
      makeUser({ silence_active: true, silence_until: "2026-05-20T00:00:00Z" }),
      "UTC",
    );
    expect(out).toContain("Silence до");
  });

  it("silence-блок не появляется когда user.silence_active=false", () => {
    const out = formatStatus(makeAssetState(), makeUser({ silence_active: false }), "UTC");
    expect(out).not.toContain("Silence");
  });

  it("user=null — silence-блок не показываем (нет user-state)", () => {
    const out = formatStatus(makeAssetState(), null, "UTC");
    expect(out).not.toContain("Silence");
  });

  it("отрицательный edge_pct — показывается со знаком '-'", () => {
    const out = formatStatus(
      makeAssetState({ last_score_breakdown: makeBreakdown({ edge_pct: -0.45 }) }),
      makeUser(),
      "UTC",
    );
    expect(out).toContain("-0.45%");
  });

  it("regime=strong — показывает 'сильное окно'", () => {
    const out = formatStatus(
      makeAssetState({ last_score_breakdown: makeBreakdown({ regime: "strong", score: 85 }) }),
      makeUser(),
      "UTC",
    );
    expect(out).toContain("85/100");
    expect(out).toContain("сильное окно");
  });

  // ============ Multi-asset (asset аргумент) ============

  it("с asset (commodity) — печатает display_name и USD-форматирование", () => {
    const state = makeAssetState({
      symbol: "XAU/USD",
      last_score_breakdown: makeBreakdown({ rate: 2340.5 }),
    });
    const asset = makeAsset();
    const out = formatStatus(state, makeUser(), "UTC", asset);
    expect(out).toContain("Gold Spot");
    expect(out).toContain("XAU/USD");
    expect(out).toContain("$2340.50");
    expect(out).not.toContain("Курс EUR/USD");
  });

  it("с asset (stock_ru) — печатает RUB форматирование (₽)", () => {
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
    const out = formatStatus(state, makeUser(), "UTC", asset);
    expect(out).toContain("Роснефть");
    expect(out).toContain("ROSN");
    expect(out).toContain("₽545.50");
  });

  it("с asset — печатает Низ 90d (p10) когда есть", () => {
    const state = makeAssetState({
      baseline_rolling_p10_90d: 2100.0,
    });
    const out = formatStatus(state, makeUser(), "UTC", makeAsset());
    expect(out).toContain("Низ 90d");
  });
});

describe("formatStatusOverview", () => {
  it("0 подписок — hint про /subscribe с примерами", () => {
    const out = formatStatusOverview([], {}, {}, makeUser());
    expect(out).toContain("нет подписок");
    expect(out).toContain("/subscribe");
    expect(out).toContain("XAU/USD");
  });

  it("одна подписка с свежими данными — показывает price/score/regime/edge", () => {
    const sub = makeSub({ symbol: "XAU/USD", direction: "buy" });
    const asset = makeAsset({ symbol: "XAU/USD", display_name: "Gold Spot", currency: "USD" });
    const state = makeAssetState({
      symbol: "XAU/USD",
      last_score_breakdown: makeBreakdown({
        rate: 2340.5,
        score: 72,
        regime: "watch",
        edge_pct: 1.5,
      }),
    });
    const out = formatStatusOverview([sub], { "XAU/USD": asset }, { "XAU/USD": state }, makeUser());
    expect(out).toContain("XAU/USD");
    expect(out).toContain("$2340.50");
    expect(out).toContain("72/100");
    expect(out).toContain("наблюдать");
    expect(out).toContain("edge +1.50%");
  });

  it("несколько подписок — каждая на своей строке", () => {
    const subs = [
      makeSub({ symbol: "XAU/USD", direction: "buy" }),
      makeSub({ symbol: "ROSN", direction: "buy" }),
    ];
    const assets = {
      "XAU/USD": makeAsset({ symbol: "XAU/USD", currency: "USD" }),
      ROSN: makeAsset({ symbol: "ROSN", display_name: "Роснефть", currency: "RUB" }),
    };
    const states = {
      "XAU/USD": makeAssetState({
        symbol: "XAU/USD",
        last_score_breakdown: makeBreakdown({ rate: 2340.5 }),
      }),
      ROSN: makeAssetState({
        symbol: "ROSN",
        last_score_breakdown: makeBreakdown({ rate: 545.5 }),
      }),
    };
    const out = formatStatusOverview(subs, assets, states, makeUser());
    expect(out).toContain("XAU/USD");
    expect(out).toContain("ROSN");
    expect(out).toContain("$2340.50");
    expect(out).toContain("₽545.50");
    expect(out).toContain("Подробнее");
  });

  it("подписка без data — показывает 'нет данных' вместо краша", () => {
    const sub = makeSub();
    const state = makeAssetState({ last_score_breakdown: null });
    const out = formatStatusOverview([sub], { "XAU/USD": makeAsset() }, { "XAU/USD": state }, null);
    expect(out).toContain("нет данных");
  });

  it("silence_active=true — добавляет блок про silence", () => {
    const sub = makeSub();
    const out = formatStatusOverview(
      [sub],
      { "XAU/USD": makeAsset() },
      { "XAU/USD": makeAssetState() },
      makeUser({ silence_active: true, silence_until: "2026-05-30T00:00:00Z" }),
    );
    expect(out).toContain("Silence до");
  });
});

describe("formatStatusNotSubscribed / NoData", () => {
  it("formatStatusNotSubscribed — указывает symbol и предлагает /subscribe", () => {
    const out = formatStatusNotSubscribed("LKOH");
    expect(out).toContain("LKOH");
    expect(out).toContain("/subscribe LKOH");
  });

  it("formatStatusNoData — называет asset и говорит про задержку analyze", () => {
    const out = formatStatusNoData(makeAsset({ symbol: "ROSN", display_name: "Роснефть" }));
    expect(out).toContain("Роснефть");
    expect(out).toContain("ROSN");
    expect(out).toContain("раз в час");
  });
});

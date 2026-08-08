import { describe, expect, it } from "vitest";
import type { Regime, ScoreBreakdown } from "../../src/analyze/scoring";
import { formatDigest, formatDigestMultiAssetSummary } from "../../src/commands/formatter";
import type {
  Asset,
  AssetState,
  BotState,
  LastScoreBreakdown,
  Subscription,
} from "../../src/state/schema";

function makeState(overrides: Partial<BotState> = {}): BotState {
  return {
    schema_version: 5,
    last_update_id: 0,
    menu_set_at: null,
    menu_commands_count: 0,
    last_digest_at: null,
    budget_target_eur: null,
    budget_deadline: null,
    budget_started_at: null,
    budget_converted_eur: 0,
    budget_converted_usd: 0,
    ...overrides,
  };
}

function makeBreakdown(overrides: Partial<ScoreBreakdown> = {}): ScoreBreakdown {
  return {
    score: 48,
    regime: "cooldown" as Regime,
    rate: 1.18234,
    components: {
      trend_daily: 50,
      timing_hourly: 40,
      extremes: 60,
      volatility: 50,
      historical: 45,
    },
    notes: [],
    ...overrides,
  };
}

describe("formatDigest", () => {
  it("breakdown=null — placeholder про закрытый рынок, без курса/edge", () => {
    const out = formatDigest(makeState(), null, null, null, "2026-05-14T09:25:00Z", "UTC");
    expect(out).toContain("Утро");
    expect(out).toContain("Свежих данных EUR/USD нет (рынок закрыт)");
    expect(out).not.toContain("Курс EUR/USD:");
    expect(out).not.toContain("Edge");
  });

  it("breakdown задан — печатает rate / edge за день / edge за месяц / резонность", () => {
    const out = formatDigest(
      makeState(),
      makeBreakdown(),
      0.1,
      -0.06,
      "2026-05-14T09:25:00Z",
      "UTC",
    );
    expect(out).toContain("Курс EUR/USD: <b>1.18234</b>");
    expect(out).toContain("Edge за день: <b>-0.06%</b>");
    expect(out).toContain("Edge за месяц: <b>+0.10%</b>");
    expect(out).toContain("Резонность: <b>48/100</b>");
    expect(out).toContain("ждать"); // regime cooldown
    // Daily edge должен идти ВЫШЕ месячного — как у пользователя в ТЗ.
    expect(out.indexOf("Edge за день")).toBeLessThan(out.indexOf("Edge за месяц"));
    // Никаких следов старого формата.
    expect(out).not.toContain("Edge над 30d");
  });

  it("edgePct=null — строчка Edge за месяц не печатается", () => {
    const out = formatDigest(
      makeState(),
      makeBreakdown(),
      null,
      null,
      "2026-05-14T09:25:00Z",
      "UTC",
    );
    expect(out).toContain("Курс EUR/USD: <b>1.18234</b>");
    expect(out).not.toContain("Edge за месяц");
    expect(out).not.toContain("Edge над 30d");
  });

  it("dailyEdgePct=null (legacy/новый asset) — строчка Edge за день не печатается, месячная остаётся", () => {
    const out = formatDigest(
      makeState(),
      makeBreakdown(),
      0.1,
      null,
      "2026-05-14T09:25:00Z",
      "UTC",
    );
    expect(out).not.toContain("Edge за день");
    expect(out).toContain("Edge за месяц: <b>+0.10%</b>");
  });

  it("dailyEdgePct положительный — печатается со знаком +", () => {
    const out = formatDigest(
      makeState(),
      makeBreakdown(),
      0.1,
      0.42,
      "2026-05-14T09:25:00Z",
      "UTC",
    );
    expect(out).toContain("Edge за день: <b>+0.42%</b>");
  });

  it("regime=strong — 'сильное окно'", () => {
    const out = formatDigest(
      makeState(),
      makeBreakdown({ regime: "strong" as Regime, score: 85 }),
      0.45,
      0.05,
      "2026-05-14T09:25:00Z",
      "UTC",
    );
    expect(out).toContain("85/100");
    expect(out).toContain("сильное окно");
  });

  it("budget неактивный — budget блок не печатается", () => {
    const out = formatDigest(
      makeState({ budget_target_eur: null }),
      makeBreakdown(),
      0.1,
      -0.06,
      "2026-05-14T09:25:00Z",
      "UTC",
    );
    expect(out).not.toContain("Бюджет");
    expect(out).not.toContain("convert");
    // Конкретные substring могут варьироваться; главное — отсутствие budget секции.
  });

  it("budget активный — формируется budget-блок (pacing existing)", () => {
    const out = formatDigest(
      makeState({
        budget_target_eur: 6000,
        budget_started_at: "2026-05-01T00:00:00Z",
        budget_deadline: "2026-06-01T00:00:00Z",
        budget_converted_eur: 1000,
      }),
      makeBreakdown(),
      0.1,
      -0.06,
      "2026-05-14T09:25:00Z",
      "UTC",
    );
    expect(out.length).toBeGreaterThan(50);
    expect(out).toMatch(/6000|EUR|€|конвертир|осталось|бюджет/i);
  });

  it("multiAssetSummary === null — текст digest без appendix (backward compat)", () => {
    const out = formatDigest(
      makeState(),
      makeBreakdown(),
      0.1,
      -0.06,
      "2026-05-14T09:25:00Z",
      "UTC",
      null,
    );
    expect(out).not.toContain("Прочие подписки");
  });

  it("multiAssetSummary задан — appendix виден в конце digest", () => {
    const summary = "📊 <b>Прочие подписки:</b>\n🥇 <b>XAU/USD</b> · 🛒 $2340.50";
    const out = formatDigest(
      makeState(),
      makeBreakdown(),
      0.1,
      -0.06,
      "2026-05-14T09:25:00Z",
      "UTC",
      summary,
    );
    expect(out).toContain("Прочие подписки");
    expect(out).toContain("XAU/USD");
    // Appendix должна быть в конце (после budget блока если есть).
    expect(out.indexOf("Прочие подписки")).toBeGreaterThan(out.indexOf("Резонность"));
  });
});

// ============ formatDigestMultiAssetSummary ============

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

function makeFullState(overrides: Partial<AssetState> = {}): AssetState {
  const breakdown: LastScoreBreakdown = {
    ts: "2026-05-24T00:00:00Z",
    score: 72,
    regime: "watch",
    rate: 2340.5,
    edge_pct: 1.5,
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
  };
  return {
    symbol: "XAU/USD",
    baseline_rolling_median_30d: 2300,
    baseline_rolling_p90_90d: 2400,
    baseline_rolling_p10_90d: 2200,
    baseline_computed_at: "2026-05-24T00:00:00Z",
    last_alert_sell_ts: null,
    last_alert_sell_regime: null,
    last_alert_sell_score: null,
    last_alert_buy_ts: null,
    last_alert_buy_regime: null,
    last_alert_buy_score: null,
    last_score_breakdown: breakdown,
    quota_credits_today: 0,
    ...overrides,
  };
}

describe("formatDigestMultiAssetSummary", () => {
  // вс 2026-05-24 — forex закрыт; данные makeFullState (ts 05-24) не считаются stale.
  const closedNow = "2026-05-24T01:00:00Z";

  it("0 non-EUR/USD подписок → null (digest остаётся forex-only)", () => {
    const subs = [makeSub({ symbol: "EUR/USD", direction: "sell" })];
    expect(formatDigestMultiAssetSummary(subs, {}, {}, closedNow)).toBeNull();
  });

  it("пустой sub list → null", () => {
    expect(formatDigestMultiAssetSummary([], {}, {}, closedNow)).toBeNull();
  });

  it("non-EUR/USD подписка → строка с price/score/regime", () => {
    const subs = [makeSub({ symbol: "XAU/USD", direction: "buy" })];
    const out = formatDigestMultiAssetSummary(
      subs,
      { "XAU/USD": makeAsset() },
      { "XAU/USD": makeFullState() },
      closedNow,
    );
    expect(out).not.toBeNull();
    expect(out).toContain("Прочие подписки");
    expect(out).toContain("XAU/USD");
    expect(out).toContain("$2340.50");
    expect(out).toContain("72/100");
    expect(out).toContain("наблюдать");
  });

  it("orphan subscription (asset снят) → ⚠️ warning, не падаем", () => {
    const subs = [makeSub({ symbol: "DEFUNCT" })];
    const out = formatDigestMultiAssetSummary(subs, {}, {}, closedNow);
    expect(out).toContain("DEFUNCT");
    expect(out).toContain("⚠️");
  });

  it("EUR/USD в подписках пропускается, остальные показываются", () => {
    const subs = [
      makeSub({ symbol: "EUR/USD", direction: "sell" }),
      makeSub({ symbol: "XAU/USD", direction: "buy" }),
    ];
    const out = formatDigestMultiAssetSummary(
      subs,
      { "XAU/USD": makeAsset() },
      { "XAU/USD": makeFullState() },
      closedNow,
    );
    expect(out).not.toContain("EUR/USD"); // primary skipped
    expect(out).toContain("XAU/USD");
  });

  it("протухший срез при ОТКРЫТОМ рынке → «нет свежих данных», старую цену НЕ показываем", () => {
    // вт 2026-06-16 forex открыт; данные старше 2ч → не выдаём за текущий курс
    const state = makeFullState();
    state.last_score_breakdown = {
      ...(state.last_score_breakdown as LastScoreBreakdown),
      ts: "2026-06-16T08:00:00Z",
    };
    const out = formatDigestMultiAssetSummary(
      [makeSub({ symbol: "XAU/USD", direction: "buy" })],
      { "XAU/USD": makeAsset() },
      { "XAU/USD": state },
      "2026-06-16T12:00:00Z",
    );
    expect(out).toContain("нет свежих данных");
    expect(out).not.toContain("$2340.50");
  });

  it("при ЗАКРЫТОМ рынке старый срез показывается (свежих и не ожидается)", () => {
    // сб 2026-06-13 forex закрыт; рендерим last известный, без пометки stale
    const state = makeFullState();
    state.last_score_breakdown = {
      ...(state.last_score_breakdown as LastScoreBreakdown),
      ts: "2026-06-10T00:00:00Z",
    };
    const out = formatDigestMultiAssetSummary(
      [makeSub({ symbol: "XAU/USD", direction: "buy" })],
      { "XAU/USD": makeAsset() },
      { "XAU/USD": state },
      "2026-06-13T12:00:00Z",
    );
    expect(out).toContain("$2340.50");
    expect(out).not.toContain("нет свежих данных");
  });
});

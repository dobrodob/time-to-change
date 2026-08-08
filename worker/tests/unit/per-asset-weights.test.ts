/**
 * Unit-тесты на per-asset weight profiles + per-type historical window.
 * Парность с Python: see tests/parity/compute-score.test.ts (default forex).
 */
import { describe, expect, it } from "vitest";
import {
  type Candle,
  HISTORICAL_WINDOW_BY_TYPE,
  WEIGHTS,
  WEIGHTS_BY_TYPE,
  computeScore,
  historicalWindowFor,
  weightsFor,
} from "../../src/analyze/scoring";

describe("WEIGHTS_BY_TYPE invariants", () => {
  it("сумма весов каждого type === 1.0 (±epsilon)", () => {
    for (const type of Object.keys(WEIGHTS_BY_TYPE) as Array<keyof typeof WEIGHTS_BY_TYPE>) {
      const profile = WEIGHTS_BY_TYPE[type];
      const sum = Object.values(profile).reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(1.0, 10);
    }
  });

  it("у каждого type есть все 5 компонент", () => {
    const expectedKeys = [
      "trend_daily",
      "timing_hourly",
      "extremes",
      "volatility",
      "historical",
    ].sort();
    for (const type of Object.keys(WEIGHTS_BY_TYPE) as Array<keyof typeof WEIGHTS_BY_TYPE>) {
      expect(Object.keys(WEIGHTS_BY_TYPE[type]).sort()).toEqual(expectedKeys);
    }
  });

  it("forex профиль идентичен legacy WEIGHTS export (backward compat)", () => {
    expect(WEIGHTS_BY_TYPE.forex).toEqual(WEIGHTS);
    // Также буквально проверяем что forex = 0.25/0.25/0.20/0.10/0.20
    expect(WEIGHTS_BY_TYPE.forex.trend_daily).toBe(0.25);
    expect(WEIGHTS_BY_TYPE.forex.timing_hourly).toBe(0.25);
    expect(WEIGHTS_BY_TYPE.forex.historical).toBe(0.2);
  });

  it("commodity = forex (золото/серебро ведут себя как валюты)", () => {
    expect(WEIGHTS_BY_TYPE.commodity).toEqual(WEIGHTS_BY_TYPE.forex);
  });

  it("stock_us: timing > trend (intraday earnings-cycle responsive)", () => {
    expect(WEIGHTS_BY_TYPE.stock_us.timing_hourly).toBeGreaterThan(
      WEIGHTS_BY_TYPE.stock_us.trend_daily,
    );
  });

  it("stock_ru === stock_us (унифицированный профиль для акций)", () => {
    expect(WEIGHTS_BY_TYPE.stock_ru).toEqual(WEIGHTS_BY_TYPE.stock_us);
  });

  it("stock_ru: timing > trend (RU news-sensitive, как stock_us)", () => {
    expect(WEIGHTS_BY_TYPE.stock_ru.timing_hourly).toBeGreaterThan(
      WEIGHTS_BY_TYPE.stock_ru.trend_daily,
    );
  });

  it("crypto: самый высокий timing (24/7 momentum)", () => {
    expect(WEIGHTS_BY_TYPE.crypto.timing_hourly).toBeGreaterThanOrEqual(
      WEIGHTS_BY_TYPE.stock_us.timing_hourly,
    );
  });
});

describe("HISTORICAL_WINDOW_BY_TYPE", () => {
  it("все major типы (forex/stock_us/stock_ru/commodity/index) = 60d", () => {
    // Унифицировано на 60d — news-driven нестабильность 2025+. Forex backtest
    // на 12 мес EUR/USD: +39% relative alpha vs 90d.
    expect(HISTORICAL_WINDOW_BY_TYPE.forex).toBe(60);
    expect(HISTORICAL_WINDOW_BY_TYPE.stock_us).toBe(60);
    expect(HISTORICAL_WINDOW_BY_TYPE.stock_ru).toBe(60);
    expect(HISTORICAL_WINDOW_BY_TYPE.commodity).toBe(60);
    expect(HISTORICAL_WINDOW_BY_TYPE.index).toBe(60);
  });

  it("crypto = 45d (ещё короче — 24/7 без business calendar)", () => {
    expect(HISTORICAL_WINDOW_BY_TYPE.crypto).toBe(45);
  });
});

describe("weightsFor / historicalWindowFor helpers", () => {
  it("undefined → forex defaults (60d)", () => {
    expect(weightsFor(undefined)).toEqual(WEIGHTS_BY_TYPE.forex);
    expect(historicalWindowFor(undefined)).toBe(60);
  });

  it("forex → forex profile (60d)", () => {
    expect(weightsFor("forex")).toEqual(WEIGHTS_BY_TYPE.forex);
    expect(historicalWindowFor("forex")).toBe(60);
  });

  it("stock_us → stock_us profile (60d)", () => {
    expect(weightsFor("stock_us")).toEqual(WEIGHTS_BY_TYPE.stock_us);
    expect(historicalWindowFor("stock_us")).toBe(60);
  });

  it("crypto → crypto profile (45d)", () => {
    expect(weightsFor("crypto")).toEqual(WEIGHTS_BY_TYPE.crypto);
    expect(historicalWindowFor("crypto")).toBe(45);
  });

  // Fail-loud guard: если будущее расширение enum AssetType забудет
  // обновить WEIGHTS_BY_TYPE / HISTORICAL_WINDOW_BY_TYPE, лучше упасть
  // быстро с понятной ошибкой, чем silently дефолтнуть на forex.
  it("неизвестный type → throws (schema drift guard)", () => {
    // @ts-expect-error — runtime test для случая schema drift (новый enum
    // вариант без соответствующего WEIGHTS_BY_TYPE entry).
    expect(() => weightsFor("bonds" as AssetType)).toThrow(/неизвестный AssetType/);
    // @ts-expect-error — runtime test для schema drift.
    expect(() => historicalWindowFor("bonds" as AssetType)).toThrow(/неизвестный AssetType/);
  });
});

// ============ computeScore с per-type ============

/**
 * Синтезируем daily candles так, чтобы EMA20 > EMA50 и historical percentile
 * был высокий → score должен сильно зависеть от направления и type.
 */
function makeBullishDaily(n = 200): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const base = 100 + i * 0.1; // монотонный аптренд
    return {
      datetime: `2026-01-01T${String(i % 24).padStart(2, "0")}:00:00Z`,
      open: base,
      high: base + 0.5,
      low: base - 0.5,
      close: base,
    };
  });
}

function makeBullishHourly(n = 100): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const base = 119 + i * 0.01;
    return {
      datetime: `2026-05-24T${String(i % 24).padStart(2, "0")}:00:00Z`,
      open: base,
      high: base + 0.05,
      low: base - 0.05,
      close: base,
    };
  });
}

describe("computeScore — per-asset weights effect on score", () => {
  it("default forex и явный forex дают идентичный score (backward compat)", () => {
    const daily = makeBullishDaily();
    const hourly = makeBullishHourly();
    const defaultScore = computeScore(daily, hourly, "sell");
    const forexScore = computeScore(daily, hourly, "sell", "forex");
    expect(forexScore.score).toBeCloseTo(defaultScore.score, 10);
    expect(forexScore.components).toEqual(defaultScore.components);
  });

  it("stock_us vs forex: разный final score при одинаковых components", () => {
    const daily = makeBullishDaily();
    const hourly = makeBullishHourly();
    const forex = computeScore(daily, hourly, "sell", "forex");
    const stockUs = computeScore(daily, hourly, "sell", "stock_us");

    // Components могут отличаться только из-за historical window (60 vs 90).
    // Остальные компоненты независимы от type.
    expect(stockUs.components.trend_daily).toBeCloseTo(forex.components.trend_daily as number, 10);
    expect(stockUs.components.timing_hourly).toBeCloseTo(
      forex.components.timing_hourly as number,
      10,
    );
    expect(stockUs.components.extremes).toBeCloseTo(forex.components.extremes as number, 10);

    // А итоговый score должен отличаться — weights разные.
    expect(stockUs.score).not.toBe(forex.score);
  });

  it("crypto window=45: historical считается на меньшем окне", () => {
    const daily = makeBullishDaily(200);
    const hourly = makeBullishHourly();
    const forex = computeScore(daily, hourly, "sell", "forex"); // window=90
    const crypto = computeScore(daily, hourly, "sell", "crypto"); // window=45

    // В монотонном аптренде percentile_rank всегда =100 (последний > всех
    // предыдущих в окне). Compare стабильность — должны быть равны (100 vs 100).
    expect(forex.components.historical).toBe(100);
    expect(crypto.components.historical).toBe(100);
    // Но weights разные → итоговый score разный.
    expect(forex.score).not.toBe(crypto.score);
  });

  it("notes отражают реальное окно historical (60d для stock_us)", () => {
    const daily = makeBullishDaily();
    const hourly = makeBullishHourly();
    const stockUs = computeScore(daily, hourly, "sell", "stock_us");
    // historical=100 >= 75 → должна быть note про окно
    const histNote = stockUs.notes.find((n) => n.includes("значений за"));
    expect(histNote).toBeDefined();
    expect(histNote).toContain("за 60 дней");
  });

  it("notes для crypto показывают 45 дней", () => {
    const daily = makeBullishDaily();
    const hourly = makeBullishHourly();
    const crypto = computeScore(daily, hourly, "sell", "crypto");
    const histNote = crypto.notes.find((n) => n.includes("значений за"));
    expect(histNote).toContain("за 45 дней");
  });

  it("forex notes показывают 60 дней (унифицировано с stock_us)", () => {
    const daily = makeBullishDaily();
    const hourly = makeBullishHourly();
    const forex = computeScore(daily, hourly, "sell");
    const histNote = forex.notes.find((n) => n.includes("значений за"));
    expect(histNote).toContain("за 60 дней");
  });
});

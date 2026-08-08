/**
 * Unit-тесты для computeDailyEdgePct — % изменения относительно вчерашней
 * дневной свечи. Используется в утреннем digest ("Edge за день").
 */
import { describe, expect, it } from "vitest";
import { computeDailyEdgePct } from "../../src/analyze/gating";
import type { Candle } from "../../src/analyze/scoring";

function candle(close: number, datetime = "2026-05-14T00:00:00Z"): Candle {
  return { datetime, open: close, high: close, low: close, close };
}

describe("computeDailyEdgePct", () => {
  it("два candle, рост — положительный %", () => {
    const out = computeDailyEdgePct([candle(1.18), candle(1.19)]);
    expect(out).not.toBeNull();
    // (1.19 - 1.18) / 1.18 * 100 ≈ 0.8475
    expect(out as number).toBeCloseTo(0.8475, 3);
  });

  it("два candle, падение — отрицательный %", () => {
    const out = computeDailyEdgePct([candle(1.2), candle(1.18)]);
    expect(out as number).toBeCloseTo(-1.6667, 3);
  });

  it("без движения — 0", () => {
    const out = computeDailyEdgePct([candle(1.18), candle(1.18)]);
    expect(out).toBe(0);
  });

  it("больше двух candle — учитываются только последние два", () => {
    const out = computeDailyEdgePct([candle(1.0), candle(1.5), candle(1.18), candle(1.19)]);
    // Игнорируем 1.0/1.5, берём 1.18→1.19
    expect(out as number).toBeCloseTo(0.8475, 3);
  });

  it("один candle — null (нет «вчера»)", () => {
    expect(computeDailyEdgePct([candle(1.18)])).toBeNull();
  });

  it("пустой массив — null", () => {
    expect(computeDailyEdgePct([])).toBeNull();
  });

  it("предыдущий close = 0 — null (защита от деления на ноль)", () => {
    expect(computeDailyEdgePct([candle(0), candle(1.18)])).toBeNull();
  });

  it("NaN в close — null", () => {
    expect(computeDailyEdgePct([candle(Number.NaN), candle(1.18)])).toBeNull();
    expect(computeDailyEdgePct([candle(1.18), candle(Number.NaN)])).toBeNull();
  });
});

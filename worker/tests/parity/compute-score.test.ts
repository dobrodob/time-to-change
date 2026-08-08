/**
 * Full-ensemble compute_score parity vs Python.
 *
 * 5 deterministic (daily, hourly) cases — 200 candles each, random-walk OHLC.
 * Закрывает silent regression risk: если TS ensemble расходится с Python,
 * alert decisions могут различаться (regime mismatch → wrong gating).
 */
import { describe, expect, it } from "vitest";
import { type Candle, computeScore } from "../../src/analyze/scoring";
import fixtures from "./fixtures/compute-score.json" with { type: "json" };

interface ComputeScoreCase {
  input: {
    daily: number[][]; // [[open, high, low, close], ...]
    hourly: number[][];
  };
  expected: {
    score: number;
    regime: string;
    rate: number;
    components: Record<string, number | null>;
    notes: string[];
  };
}

function toCandles(rows: number[][]): Candle[] {
  return rows.map((r, i) => ({
    datetime: `2026-01-01T${String(i % 24).padStart(2, "0")}:00:00Z`,
    open: r[0],
    high: r[1],
    low: r[2],
    close: r[3],
  }));
}

describe("computeScore parity (Python full ensemble)", () => {
  for (const [i, c] of (fixtures as ComputeScoreCase[]).entries()) {
    it(`case ${i}: daily=${c.input.daily.length}, hourly=${c.input.hourly.length}, expect regime=${c.expected.regime}`, () => {
      const daily = toCandles(c.input.daily);
      const hourly = toCandles(c.input.hourly);
      const actual = computeScore(daily, hourly);

      // Float tolerance — pandas vs raw JS могут чуть-чуть рассходиться
      // на edge cases (rounding в std). 1e-6 — приемлемо для score ≤100.
      expect(actual.rate).toBeCloseTo(c.expected.rate, 6);
      expect(actual.score).toBeCloseTo(c.expected.score, 5);
      expect(actual.regime).toBe(c.expected.regime);

      // Components: каждый float vs Python с tolerance.
      for (const key of Object.keys(c.expected.components)) {
        const expectedV = c.expected.components[key];
        const actualV = actual.components[key];
        if (expectedV === null) {
          expect(actualV).toBeNull();
        } else {
          expect(actualV).not.toBeNull();
          expect(actualV as number).toBeCloseTo(expectedV, 5);
        }
      }

      // Notes — НЕ часть parity invariant. Это пользовательские строки которые
      // могут эволюционировать (humanization, локализация). Math и gating
      // decision verified выше — это что важно.
      expect(actual.notes.length).toBeGreaterThan(0);
    });
  }
});

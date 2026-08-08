/**
 * Parity tests: TS indicators vs Python golden output.
 * Fixtures сгенерированы tools/scripts/gen_parity_fixtures.py.
 */
import { describe, expect, it } from "vitest";
import { ema, percentileRank, rsi } from "../../src/analyze/indicators";
import emaFixtures from "./fixtures/ema.json" with { type: "json" };
import percentileFixtures from "./fixtures/percentile-rank.json" with { type: "json" };
import rsiFixtures from "./fixtures/rsi.json" with { type: "json" };

/**
 * Сравнение массивов с tolerance + null/NaN.
 * Python NaN → JSON null. TS NaN → Number.NaN. Конвертируем для сравнения.
 */
function expectArraysClose(actual: number[], expected: (number | null)[]): void {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    const e = expected[i];
    if (e === null) {
      expect(Number.isNaN(actual[i])).toBe(true);
    } else {
      expect(actual[i]).toBeCloseTo(e, 9);
    }
  }
}

describe("ema parity (Python)", () => {
  for (const c of emaFixtures as Array<{
    input: { values: number[]; window: number };
    expected: (number | null)[];
  }>) {
    it(`window=${c.input.window}, n=${c.input.values.length}`, () => {
      const actual = ema(c.input.values, c.input.window);
      expectArraysClose(actual, c.expected);
    });
  }
});

describe("rsi parity (Python)", () => {
  for (const c of rsiFixtures as Array<{
    input: { values: number[]; window: number };
    expected: (number | null)[];
  }>) {
    it(`window=${c.input.window}, n=${c.input.values.length}`, () => {
      const actual = rsi(c.input.values, c.input.window);
      expectArraysClose(actual, c.expected);
    });
  }
});

describe("percentileRank parity (Python)", () => {
  for (const c of percentileFixtures as Array<{
    input: { values: number[]; target: number };
    expected: number;
  }>) {
    it(`target=${c.input.target} среди ${c.input.values.length} значений`, () => {
      const actual = percentileRank(c.input.values, c.input.target);
      expect(actual).toBeCloseTo(c.expected, 9);
    });
  }
});

/**
 * Parity test: classifyRegime vs Python classify_regime.
 */
import { describe, expect, it } from "vitest";
import { classifyRegime } from "../../src/analyze/scoring";
import fixtures from "./fixtures/classify-regime.json" with { type: "json" };

describe("classifyRegime parity (Python)", () => {
  for (const c of fixtures as Array<{ input: { score: number }; expected: string }>) {
    it(`score=${c.input.score} → ${c.expected}`, () => {
      expect(classifyRegime(c.input.score)).toBe(c.expected);
    });
  }
});

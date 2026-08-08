/**
 * Parity test: computeEdgePct vs Python compute_edge_pct.
 */
import { describe, expect, it } from "vitest";
import { computeEdgePct } from "../../src/analyze/gating";
import fixtures from "./fixtures/compute-edge-pct.json" with { type: "json" };

describe("computeEdgePct parity (Python)", () => {
  for (const c of fixtures as Array<{
    input: { rate: number; baseline_median_30d: number | null };
    expected: number;
  }>) {
    it(`rate=${c.input.rate} baseline=${c.input.baseline_median_30d}`, () => {
      const actual = computeEdgePct(c.input.rate, c.input.baseline_median_30d);
      expect(actual).toBeCloseTo(c.expected, 9);
    });
  }
});

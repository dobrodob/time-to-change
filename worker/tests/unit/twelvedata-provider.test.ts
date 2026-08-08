import { describe, expect, it } from "vitest";
import { parseValues } from "../../src/analyze/providers/twelvedata";

describe("TwelveData candle validation", () => {
  it("keeps only finite OHLC rows and sorts them", () => {
    const candles = parseValues([
      { datetime: "2026-08-02", open: "2", high: "3", low: "1", close: "2.5" },
      { datetime: "2026-08-01", open: "1", high: "2", low: "0.5", close: "1.5" },
      { datetime: "2026-08-03", open: "NaN", high: "3", low: "1", close: "2" },
      { datetime: "", open: "1", high: "2", low: "0.5", close: "1.5" },
    ]);
    expect(candles.map((candle) => candle.datetime)).toEqual(["2026-08-01", "2026-08-02"]);
  });
});

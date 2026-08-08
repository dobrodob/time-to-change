import { describe, expect, it } from "vitest";
import { isMarketOpen } from "../../src/analyze/market-calendar";

describe("isMarketOpen (UTC)", () => {
  // Mon-Thu всегда открыт
  it("Monday 10:00 UTC → open", () => {
    expect(isMarketOpen("2026-05-11T10:00:00Z")).toBe(true);
  });
  it("Thursday 23:00 UTC → open", () => {
    expect(isMarketOpen("2026-05-14T23:00:00Z")).toBe(true);
  });

  // Friday
  it("Friday 21:59 UTC → open", () => {
    expect(isMarketOpen("2026-05-15T21:59:00Z")).toBe(true);
  });
  it("Friday 22:00 UTC → closed", () => {
    expect(isMarketOpen("2026-05-15T22:00:00Z")).toBe(false);
  });

  // Saturday — always closed
  it("Saturday 00:00 UTC → closed", () => {
    expect(isMarketOpen("2026-05-16T00:00:00Z")).toBe(false);
  });
  it("Saturday 23:59 UTC → closed", () => {
    expect(isMarketOpen("2026-05-16T23:59:00Z")).toBe(false);
  });

  // Sunday
  it("Sunday 21:59 UTC → closed", () => {
    expect(isMarketOpen("2026-05-17T21:59:00Z")).toBe(false);
  });
  it("Sunday 22:00 UTC → open", () => {
    expect(isMarketOpen("2026-05-17T22:00:00Z")).toBe(true);
  });

  it("throws on invalid input", () => {
    expect(() => isMarketOpen("not a date")).toThrow();
  });
});

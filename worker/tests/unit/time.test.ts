import { describe, expect, it } from "vitest";
import { addMs, diffMs, isAfter, isInQuietWindow, madridHourFromUtc } from "../../src/lib/time";

describe("madridHourFromUtc — DST handling", () => {
  it("CEST (summer, UTC+2): 08:25 UTC → 10:25 Madrid", () => {
    expect(madridHourFromUtc("2026-05-12T08:25:00Z")).toBe(10);
  });

  it("CEST: 22:00 UTC → 00:00 Madrid next day (hour=0)", () => {
    expect(madridHourFromUtc("2026-05-12T22:00:00Z")).toBe(0);
  });

  it("CET (winter, UTC+1): 08:25 UTC → 09:25 Madrid", () => {
    expect(madridHourFromUtc("2026-01-15T08:25:00Z")).toBe(9);
  });

  it("CET: 23:30 UTC → 00:30 Madrid (hour=0)", () => {
    expect(madridHourFromUtc("2026-01-15T23:30:00Z")).toBe(0);
  });

  it("DST spring forward (last Sunday Mar 2026 = Mar 29): 00:30 UTC → 01:30 Madrid (still CET)", () => {
    expect(madridHourFromUtc("2026-03-29T00:30:00Z")).toBe(1);
  });

  it("DST spring forward: 02:30 UTC → 04:30 Madrid (now CEST, jumped 02→03)", () => {
    expect(madridHourFromUtc("2026-03-29T02:30:00Z")).toBe(4);
  });

  it("DST fall back (last Sunday Oct 2026 = Oct 25): 00:30 UTC → 02:30 Madrid (CEST → CET ambiguous, Intl picks first)", () => {
    expect(madridHourFromUtc("2026-10-25T00:30:00Z")).toBe(2);
  });

  it("throws on invalid input", () => {
    expect(() => madridHourFromUtc("not a date")).toThrow(/Invalid UTC ISO/);
  });
});

describe("isInQuietWindow", () => {
  // For these we pick UTC moments such that Madrid hour is unambiguous.
  // 2026-05-12 (CEST = UTC+2): Madrid hour = utc hour + 2 (mod 24).

  it("zero-length window 0→0 = always false", () => {
    expect(isInQuietWindow("2026-05-12T05:00:00Z", 0, 0)).toBe(false);
    expect(isInQuietWindow("2026-05-12T23:00:00Z", 0, 0)).toBe(false);
  });

  it("regular window 22→23 (1 hour): 20:30 UTC → 22:30 Madrid → IN", () => {
    expect(isInQuietWindow("2026-05-12T20:30:00Z", 22, 23)).toBe(true);
  });

  it("regular window 22→23: 21:30 UTC → 23:30 Madrid → OUT (toHour exclusive)", () => {
    expect(isInQuietWindow("2026-05-12T21:30:00Z", 22, 23)).toBe(false);
  });

  it("cross-midnight 23→7: 21:30 UTC → 23:30 Madrid → IN", () => {
    expect(isInQuietWindow("2026-05-12T21:30:00Z", 23, 7)).toBe(true);
  });

  it("cross-midnight 23→7: 03:00 UTC → 05:00 Madrid → IN", () => {
    expect(isInQuietWindow("2026-05-12T03:00:00Z", 23, 7)).toBe(true);
  });

  it("cross-midnight 23→7: 05:00 UTC → 07:00 Madrid → OUT (toHour exclusive)", () => {
    expect(isInQuietWindow("2026-05-12T05:00:00Z", 23, 7)).toBe(false);
  });

  it("cross-midnight 23→7: 04:59 UTC → 06:59 Madrid → IN", () => {
    expect(isInQuietWindow("2026-05-12T04:59:00Z", 23, 7)).toBe(true);
  });

  it("cross-midnight 23→7: 08:00 UTC → 10:00 Madrid → OUT", () => {
    expect(isInQuietWindow("2026-05-12T08:00:00Z", 23, 7)).toBe(false);
  });
});

describe("isAfter / diffMs / addMs", () => {
  it("isAfter true когда a > b", () => {
    expect(isAfter("2026-05-12T10:00:00Z", "2026-05-12T09:00:00Z")).toBe(true);
    expect(isAfter("2026-05-12T09:00:00Z", "2026-05-12T10:00:00Z")).toBe(false);
  });

  it("diffMs возвращает миллисекунды между ISO", () => {
    expect(diffMs("2026-05-12T10:00:00Z", "2026-05-12T09:00:00Z")).toBe(3600 * 1000);
  });

  it("addMs прибавляет миллисекунды к ISO", () => {
    expect(addMs("2026-05-12T10:00:00Z", 3600 * 1000)).toBe("2026-05-12T11:00:00.000Z");
  });
});

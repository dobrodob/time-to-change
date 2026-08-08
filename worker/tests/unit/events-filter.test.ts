import { describe, expect, it } from "vitest";
import {
  blackoutEventRange,
  findBlackout,
  nextEventAfter,
  toBlackoutWindow,
} from "../../src/analyze/events-filter";

const fomc = { id: 1, ts: "2026-06-12T18:00:00Z", type: "FOMC", description: "Rate decision" };
const ecb = { id: 2, ts: "2026-06-15T12:00:00Z", type: "ECB", description: null };
const nfp = { id: 3, ts: "2026-06-05T13:30:00Z", type: "NFP", description: null };

describe("toBlackoutWindow", () => {
  it("FOMC: 120 min before, 240 min after", () => {
    const w = toBlackoutWindow(fomc);
    expect(w.blackoutStart).toBe("2026-06-12T16:00:00.000Z");
    expect(w.blackoutEnd).toBe("2026-06-12T22:00:00.000Z");
  });
  it("ECB: 90 min before, 180 min after", () => {
    const w = toBlackoutWindow(ecb);
    expect(w.blackoutStart).toBe("2026-06-15T10:30:00.000Z");
    expect(w.blackoutEnd).toBe("2026-06-15T15:00:00.000Z");
  });
  it("OTHER fallback for unknown type", () => {
    const w = toBlackoutWindow({
      id: 4,
      ts: "2026-06-01T12:00:00Z",
      type: "WEIRD",
      description: null,
    });
    expect(w.blackoutStart).toBe("2026-06-01T11:30:00.000Z");
    expect(w.blackoutEnd).toBe("2026-06-01T13:00:00.000Z");
  });
});

describe("findBlackout", () => {
  const events = [fomc, ecb, nfp];

  it("returns window when inside blackout", () => {
    expect(findBlackout("2026-06-12T17:00:00Z", events)?.type).toBe("FOMC");
  });
  it("returns null outside all windows", () => {
    expect(findBlackout("2026-06-10T00:00:00Z", events)).toBeNull();
  });
  it("returns null 1 min after end", () => {
    expect(findBlackout("2026-06-12T22:01:00Z", events)).toBeNull();
  });
  it("boundary at blackout_start → in", () => {
    expect(findBlackout("2026-06-12T16:00:00Z", events)?.type).toBe("FOMC");
  });
});

describe("blackoutEventRange", () => {
  it("includes events whose post-event blackout is still active", () => {
    const range = blackoutEventRange("2026-06-12T20:00:00Z");
    expect(range.from).toBe("2026-06-12T16:00:00.000Z");
    expect(range.to).toBe("2026-06-12T22:00:00.000Z");
    expect(new Date(fomc.ts).getTime()).toBeGreaterThanOrEqual(new Date(range.from).getTime());
    expect(findBlackout("2026-06-12T20:00:00Z", [fomc])?.type).toBe("FOMC");
  });
});

describe("nextEventAfter", () => {
  const events = [fomc, ecb, nfp];

  it("picks earliest blackout_start after now", () => {
    expect(nextEventAfter("2026-06-01T00:00:00Z", events)?.type).toBe("NFP");
  });
  it("skips events whose blackout_start passed", () => {
    expect(nextEventAfter("2026-06-13T00:00:00Z", events)?.type).toBe("ECB");
  });
  it("returns null if all in past", () => {
    expect(nextEventAfter("2027-01-01T00:00:00Z", events)).toBeNull();
  });
});

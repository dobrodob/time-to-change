import { describe, expect, it } from "vitest";
import { computePacing } from "../../src/budget/pacing";
import type { BotState } from "../../src/state/schema";

function makeState(overrides: Partial<BotState> = {}): BotState {
  return {
    schema_version: 5,
    last_update_id: 0,
    menu_set_at: null,
    menu_commands_count: 0,
    last_digest_at: null,
    budget_target_eur: null,
    budget_deadline: null,
    budget_started_at: null,
    budget_converted_eur: 0,
    budget_converted_usd: 0,
    ...overrides,
  };
}

describe("computePacing", () => {
  it("returns null when budget inactive", () => {
    expect(computePacing(makeState(), "2026-05-12T10:00:00Z")).toBeNull();
  });

  it("on_track first day (days_elapsed < 1)", () => {
    const s = makeState({
      budget_target_eur: 6000,
      budget_started_at: "2026-05-12T00:00:00Z",
      budget_deadline: "2026-06-12T00:00:00Z",
      budget_converted_eur: 0,
    });
    const p = computePacing(s, "2026-05-12T10:00:00Z")!;
    expect(p.pressure).toBe("on_track");
    expect(p.suggested_pct).toBe(30);
  });

  it("ahead when progress > 1.15 * expected (and elapsed > 1 day)", () => {
    // 10 days elapsed of 30, expected_pct = 33%, actual = 50% → ratio 1.5 ahead
    const s = makeState({
      budget_target_eur: 6000,
      budget_started_at: "2026-05-12T00:00:00Z",
      budget_deadline: "2026-06-11T00:00:00Z",
      budget_converted_eur: 3000, // 50%
    });
    const p = computePacing(s, "2026-05-22T00:00:00Z")!; // 10 days in
    expect(p.pressure).toBe("ahead");
    expect(p.suggested_pct).toBe(20);
  });

  it("behind when progress < 0.85 * expected", () => {
    // 20 days of 30, expected 67%, actual 20% → ratio 0.3 behind
    const s = makeState({
      budget_target_eur: 6000,
      budget_started_at: "2026-05-12T00:00:00Z",
      budget_deadline: "2026-06-11T00:00:00Z",
      budget_converted_eur: 1200,
    });
    const p = computePacing(s, "2026-06-01T00:00:00Z")!;
    expect(p.pressure).toBe("behind");
    expect(p.suggested_pct).toBe(50);
  });

  it("critical when < 3 days left и remaining > 0", () => {
    const s = makeState({
      budget_target_eur: 6000,
      budget_started_at: "2026-05-12T00:00:00Z",
      budget_deadline: "2026-06-11T00:00:00Z",
      budget_converted_eur: 4000,
    });
    const p = computePacing(s, "2026-06-09T00:00:00Z")!; // 2 days left
    expect(p.pressure).toBe("critical");
    expect(p.suggested_pct).toBe(80);
  });

  it("ahead when remaining = 0", () => {
    const s = makeState({
      budget_target_eur: 6000,
      budget_started_at: "2026-05-12T00:00:00Z",
      budget_deadline: "2026-06-11T00:00:00Z",
      budget_converted_eur: 6000,
    });
    const p = computePacing(s, "2026-05-20T00:00:00Z")!;
    expect(p.pressure).toBe("ahead");
  });

  it("daily_target_eur = remaining / days_left", () => {
    const s = makeState({
      budget_target_eur: 6000,
      budget_started_at: "2026-05-12T00:00:00Z",
      budget_deadline: "2026-06-11T00:00:00Z",
      budget_converted_eur: 0,
    });
    const p = computePacing(s, "2026-05-22T00:00:00Z")!; // 20 days left
    expect(p.daily_target_eur).toBeCloseTo(6000 / 20, 1);
  });
});

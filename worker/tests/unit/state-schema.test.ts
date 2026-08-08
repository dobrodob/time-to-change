import { describe, expect, it } from "vitest";
import {
  alertRecordSchema,
  botStateSchema,
  conversionSchema,
  eventSchema,
  lastScoreBreakdownSchema,
  userSchema,
} from "../../src/state/schema";

describe("state schemas", () => {
  it("user roundtrip", () => {
    const u = {
      chat_id: 1001,
      role: "owner" as const,
      name: "Алекс",
      joined_at: "2026-05-07T22:42:32.901441Z",
      silence_active: false,
      silence_until: null,
      silence_reason: null,
      quiet_enabled: false,
      quiet_from_hour: 23,
      quiet_to_hour: 7,
      digest_enabled: true,
    };
    expect(userSchema.parse(u)).toEqual(u);
  });

  it("user rejects role not owner/member", () => {
    expect(() =>
      userSchema.parse({
        chat_id: 1,
        role: "admin",
        name: null,
        joined_at: "2026-01-01T00:00:00Z",
        silence_active: false,
        silence_until: null,
        silence_reason: null,
        quiet_enabled: false,
        quiet_from_hour: 0,
        quiet_to_hour: 0,
        digest_enabled: true,
      }),
    ).toThrow();
  });

  it("user rejects quiet hour > 23", () => {
    expect(() =>
      userSchema.parse({
        chat_id: 1,
        role: "member",
        name: null,
        joined_at: "2026-01-01T00:00:00Z",
        silence_active: false,
        silence_until: null,
        silence_reason: null,
        quiet_enabled: true,
        quiet_from_hour: 24,
        quiet_to_hour: 7,
        digest_enabled: true,
      }),
    ).toThrow();
  });

  it("alertRecord roundtrip", () => {
    const a = {
      ts: "2026-05-12T10:00:00Z",
      regime: "partial",
      score: 78.5,
      rate: 1.18,
      edge_pct: 2.3,
    };
    expect(alertRecordSchema.parse(a)).toEqual(a);
  });

  it("lastScoreBreakdown with notes and components", () => {
    const b = {
      ts: "2026-05-12T10:00:00Z",
      score: 75.5,
      regime: "partial",
      rate: 1.18,
      edge_pct: 2.5,
      components: {
        trend_daily: 100,
        timing_hourly: 60,
        extremes: 30,
        volatility: 100,
        historical: 75,
      },
      notes: ["golden cross", "high percentile"],
      was_alert: true,
      gate_reason: null,
    };
    expect(lastScoreBreakdownSchema.parse(b)).toEqual(b);
  });

  it("botState round-trip (post-migration 0005 schema)", () => {
    // baseline_*, quota_*, consecutive_failures, last_alert_json,
    // last_score_breakdown_json удалены в migration 0005 — данные ушли в asset_state.
    const s = {
      schema_version: 5,
      last_update_id: 12345,
      menu_set_at: "2026-05-10T11:52:17Z",
      menu_commands_count: 12,
      last_digest_at: "2026-05-14T09:25:00Z",
      budget_target_eur: 6000,
      budget_deadline: "2026-06-12T00:00:00Z",
      budget_started_at: "2026-05-12T00:00:00Z",
      budget_converted_eur: 1500,
      budget_converted_usd: 1627.5,
    };
    expect(botStateSchema.parse(s)).toEqual(s);
  });

  it("conversion + event roundtrip", () => {
    expect(
      conversionSchema.parse({
        ts: "2026-05-12T10:00:00Z",
        eur: 1500,
        rate: 1.0852,
        pct_at_alert: 30,
      }),
    ).toEqual({ ts: "2026-05-12T10:00:00Z", eur: 1500, rate: 1.0852, pct_at_alert: 30 });
    expect(
      eventSchema.parse({
        id: 1,
        ts: "2026-06-12T18:00:00Z",
        type: "FOMC",
        description: "Rate decision",
      }),
    ).toEqual({ id: 1, ts: "2026-06-12T18:00:00Z", type: "FOMC", description: "Rate decision" });
  });
});

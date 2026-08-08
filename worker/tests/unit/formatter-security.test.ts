import { describe, expect, it } from "vitest";
import type { ScoreBreakdown } from "../../src/analyze/scoring";
import {
  alertInlineKeyboard,
  formatAlert,
  formatHelp,
  formatUsersList,
} from "../../src/commands/formatter";
import { budgetStateForRole } from "../../src/lib/privacy";
import type { Asset, BotState, User } from "../../src/state/schema";

const state: BotState = {
  schema_version: 5,
  last_update_id: 0,
  menu_set_at: null,
  menu_commands_count: 0,
  last_digest_at: null,
  budget_target_eur: 6000,
  budget_deadline: "2026-09-08T00:00:00.000Z",
  budget_started_at: "2026-08-08T00:00:00.000Z",
  budget_converted_eur: 1000,
  budget_converted_usd: 1100,
};

const breakdown: ScoreBreakdown = {
  score: 85,
  regime: "strong",
  rate: 1.1,
  components: {},
  notes: ["safe"],
};

const asset: Asset = {
  symbol: "EUR/USD",
  display_name: "<b>Injected</b> & Co",
  type: "forex",
  provider: "twelvedata",
  currency: "USD",
  active: true,
  added_at: "2026-08-08T00:00:00.000Z",
};

describe("Telegram rendering privacy", () => {
  it("removes owner budget fields for a member", () => {
    const visible = budgetStateForRole(state, "member");
    expect(visible.budget_target_eur).toBeNull();
    expect(visible.budget_deadline).toBeNull();
    expect(visible.budget_converted_eur).toBe(0);
    expect(state.budget_target_eur).toBe(6000);
  });

  it("escapes provider-controlled HTML in alerts", () => {
    const out = formatAlert(breakdown, 1, "2026-08-08T00:00:00.000Z", state, "UTC", {
      asset,
      direction: "sell",
    });
    expect(out).toContain("&lt;b&gt;Injected&lt;/b&gt; &amp; Co");
    expect(out).not.toContain("<b>Injected</b>");
  });

  it("omits conversion actions for members", () => {
    const keyboard = alertInlineKeyboard(
      breakdown,
      budgetStateForRole(state, "member"),
      "2026-08-08T00:00:00.000Z",
      { asset, direction: "sell" },
      { includeConversionActions: false },
    );
    expect(keyboard.flat().map((button) => button.callback_data)).toEqual(["b:sil:1d", "b:sil:7d"]);
  });

  it("hides owner-only commands from member help", () => {
    const help = formatHelp("member");
    expect(help).not.toContain("/budget");
    expect(help).not.toContain("/users");
    expect(formatHelp("owner")).toContain("/budget");
  });

  it("escapes Telegram names in the owner-only users list", () => {
    const user: User = {
      chat_id: 1,
      role: "member",
      name: "<i>Eve</i> & Mallory",
      joined_at: "2026-08-08T00:00:00.000Z",
      silence_active: false,
      silence_until: null,
      silence_reason: null,
      quiet_enabled: false,
      quiet_from_hour: 23,
      quiet_to_hour: 7,
      digest_enabled: true,
    };
    const out = formatUsersList([user]);
    expect(out).toContain("&lt;i&gt;Eve&lt;/i&gt; &amp; Mallory");
    expect(out).not.toContain("<i>Eve</i>");
  });
});

import { describe, expect, it, vi } from "vitest";
import { dispatchCallback, dispatchMessage } from "../../src/commands/handlers";
import type { ValidatedEnv } from "../../src/env";
import type { StateRepo } from "../../src/state/repo";
import type { BotState, User } from "../../src/state/schema";
import type { TelegramClient } from "../../src/telegram/api";
import { parseCallbackV2, parseCommand } from "../../src/telegram/parser";
import type { TelegramCallbackQuery, TelegramMessage } from "../../src/telegram/types";

const botState: BotState = {
  schema_version: 5,
  last_update_id: 0,
  menu_set_at: "2026-08-08T00:00:00.000Z",
  menu_commands_count: 13,
  last_digest_at: null,
  budget_target_eur: 6000,
  budget_deadline: "2026-09-08T00:00:00.000Z",
  budget_started_at: "2026-08-08T00:00:00.000Z",
  budget_converted_eur: 0,
  budget_converted_usd: 0,
};

function makeUser(role: User["role"]): User {
  return {
    chat_id: 100,
    role,
    name: role,
    joined_at: "2026-08-08T00:00:00.000Z",
    silence_active: false,
    silence_until: null,
    silence_reason: null,
    quiet_enabled: false,
    quiet_from_hour: 23,
    quiet_to_hour: 7,
    digest_enabled: true,
  };
}

function makeRepo(role: User["role"]) {
  const user = makeUser(role);
  return {
    getBotState: vi.fn().mockResolvedValue(botState),
    expireSilencesIfDue: vi.fn().mockResolvedValue(0),
    getUser: vi.fn().mockResolvedValue(user),
    listUsers: vi.fn().mockResolvedValue([user]),
    getRecentAlerts: vi.fn().mockResolvedValue([]),
    getRecentAlertsForUser: vi.fn().mockResolvedValue([]),
    listConversions: vi.fn().mockResolvedValue([]),
    removeUser: vi.fn().mockResolvedValue(true),
    addConversion: vi.fn().mockResolvedValue(undefined),
    getPrimaryAssetState: vi.fn().mockResolvedValue(null),
  };
}

function makeTelegram() {
  return {
    sendMessage: vi.fn().mockResolvedValue(1),
    setMyCommands: vi.fn().mockResolvedValue(undefined),
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    editMessageReplyMarkup: vi.fn().mockResolvedValue(undefined),
  };
}

function message(text: string): TelegramMessage {
  return {
    message_id: 1,
    date: 1,
    chat: { id: 100, type: "private" },
    from: { id: 100, first_name: "Member" },
    text,
  };
}

const env = {
  TELEGRAM_BOT_TOKEN: "test",
  TELEGRAM_WEBHOOK_SECRET: "x".repeat(32),
  TWELVEDATA_API_KEY: "test",
  DB: {} as D1Database,
} satisfies ValidatedEnv;

describe("owner/member access boundaries", () => {
  it("scopes /history to the requesting member", async () => {
    const repo = makeRepo("member");
    const tg = makeTelegram();
    await dispatchMessage(
      env,
      repo as unknown as StateRepo,
      tg as unknown as TelegramClient,
      message("/history"),
      parseCommand("/history"),
    );
    expect(repo.getRecentAlertsForUser).toHaveBeenCalledWith(100, 10);
    expect(repo.getRecentAlerts).not.toHaveBeenCalled();
  });

  it("does not expose /users to a member", async () => {
    const repo = makeRepo("member");
    const tg = makeTelegram();
    await dispatchMessage(
      env,
      repo as unknown as StateRepo,
      tg as unknown as TelegramClient,
      message("/users"),
      parseCommand("/users"),
    );
    expect(repo.listUsers).not.toHaveBeenCalled();
    expect(tg.sendMessage.mock.calls.at(-1)?.[1]).toContain("только для владельца");
  });

  it("does not let a member read the singleton budget", async () => {
    const repo = makeRepo("member");
    const tg = makeTelegram();
    await dispatchMessage(
      env,
      repo as unknown as StateRepo,
      tg as unknown as TelegramClient,
      message("/budget"),
      parseCommand("/budget"),
    );
    expect(repo.listConversions).not.toHaveBeenCalled();
    expect(tg.sendMessage.mock.calls.at(-1)?.[1]).toContain("только для владельца");
  });

  it("prevents the owner from relinquishing ownership with /leave", async () => {
    const repo = makeRepo("owner");
    const tg = makeTelegram();
    await dispatchMessage(
      env,
      repo as unknown as StateRepo,
      tg as unknown as TelegramClient,
      message("/leave"),
      parseCommand("/leave"),
    );
    expect(repo.removeUser).not.toHaveBeenCalled();
    expect(tg.sendMessage.mock.calls.at(-1)?.[1]).toContain("Владелец");
  });

  it("rejects a member's conversion callback without mutating budget state", async () => {
    const repo = makeRepo("member");
    const tg = makeTelegram();
    const callback: TelegramCallbackQuery = {
      id: "callback-id",
      from: { id: 100 },
      message: message("alert"),
      data: "b:done:30",
    };
    await dispatchCallback(
      env,
      repo as unknown as StateRepo,
      tg as unknown as TelegramClient,
      callback,
      parseCallbackV2("b:done:30"),
    );
    expect(repo.addConversion).not.toHaveBeenCalled();
    expect(tg.answerCallbackQuery).toHaveBeenCalledWith("callback-id", "Только для владельца.");
  });
});

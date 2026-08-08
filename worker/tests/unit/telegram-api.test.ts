import { beforeEach, describe, expect, it, vi } from "vitest";
import { TelegramAuthError, TelegramBlockedError, TelegramClient } from "../../src/telegram/api";

describe("TelegramClient", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("sendMessage POSTs to api.telegram.org/sendMessage", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const c = new TelegramClient("test-token");
    const id = await c.sendMessage(100, "hi");
    expect(id).toBe(42);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/bottest-token/sendMessage",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("sendMessage with inline keyboard serializes correctly", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const c = new TelegramClient("tok");
    await c.sendMessage(100, "x", {
      reply_markup: [[{ text: "Done", callback_data: "b:done:30" }]],
    });
    const callBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(callBody.reply_markup.inline_keyboard).toEqual([
      [{ text: "Done", callback_data: "b:done:30" }],
    ]);
  });

  it("throws TelegramAuthError on 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 })),
    );
    const c = new TelegramClient("t");
    await expect(c.sendMessage(100, "x")).rejects.toThrow(TelegramAuthError);
  });

  it("throws TelegramBlockedError on 403", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("blocked", { status: 403 })));
    const c = new TelegramClient("t");
    await expect(c.sendMessage(100, "x")).rejects.toThrow(TelegramBlockedError);
  });

  it("sanitizes network failures so the token cannot reach upstream logs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("failed https://api.telegram.org/botsecret-token/sendMessage")),
    );
    const c = new TelegramClient("secret-token");
    const error = await c.sendMessage(100, "x").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Telegram request failed");
    expect((error as Error).message).not.toContain("secret-token");
  });

  it("answerCallbackQuery sends to correct endpoint", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const c = new TelegramClient("tok");
    await c.answerCallbackQuery("cb-id-1", "Записал ✓");
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.telegram.org/bottok/answerCallbackQuery");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.callback_query_id).toBe("cb-id-1");
    expect(body.text).toBe("Записал ✓");
  });

  it("setMyCommands POSTs commands list", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const c = new TelegramClient("tok");
    await c.setMyCommands([{ command: "start", description: "Начать" }]);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.telegram.org/bottok/setMyCommands");
  });

  it("setMyCommands fails instead of caching a rejected menu update", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("bad request", { status: 400 })));
    const c = new TelegramClient("tok");
    await expect(c.setMyCommands([{ command: "start", description: "Start" }])).rejects.toThrow(
      "Telegram setMyCommands failed with status 400",
    );
  });
});

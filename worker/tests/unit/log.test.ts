import { afterEach, describe, expect, it, vi } from "vitest";
import { log } from "../../src/lib/log";

afterEach(() => vi.restoreAllMocks());

describe("log", () => {
  it("emits single JSON line with ts, level, op", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    log("info", "test_op");
    expect(spy).toHaveBeenCalledTimes(1);
    const arg = spy.mock.calls[0][0] as string;
    const parsed = JSON.parse(arg);
    expect(parsed.level).toBe("info");
    expect(parsed.op).toBe("test_op");
    expect(typeof parsed.ts).toBe("string");
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    spy.mockRestore();
  });

  it("merges safe context and drops personal or raw-error fields", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    log("error", "telegram_send_failed", {
      chat_id: 100,
      name: "Alice",
      error: "request failed at https://example.test/?token=secret",
      error_kind: "TypeError",
      status: 403,
    });
    const parsed = JSON.parse(spy.mock.calls[0][0] as string);
    expect(parsed.chat_id).toBeUndefined();
    expect(parsed.name).toBeUndefined();
    expect(parsed.error).toBeUndefined();
    expect(parsed.error_kind).toBe("TypeError");
    expect(parsed.status).toBe(403);
    expect(parsed.level).toBe("error");
    spy.mockRestore();
  });

  it("does not let context spoof reserved fields", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    log("warn", "real_op", { level: "info", op: "spoofed", ts: "yesterday" });
    const parsed = JSON.parse(spy.mock.calls[0][0] as string);
    expect(parsed.level).toBe("warn");
    expect(parsed.op).toBe("real_op");
    expect(parsed.ts).not.toBe("yesterday");
    spy.mockRestore();
  });

  it("ctx defaults to empty when omitted", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    log("debug", "ping");
    const parsed = JSON.parse(spy.mock.calls[0][0] as string);
    expect(parsed.op).toBe("ping");
    expect(Object.keys(parsed)).toEqual(["ts", "level", "op"]);
    spy.mockRestore();
  });
});

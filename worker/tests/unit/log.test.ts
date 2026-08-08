import { describe, expect, it, vi } from "vitest";
import { log } from "../../src/lib/log";

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

  it("merges ctx into log entry", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    log("error", "telegram_send_failed", { chat_id: 100, status: 403 });
    const parsed = JSON.parse(spy.mock.calls[0][0] as string);
    expect(parsed.chat_id).toBe(100);
    expect(parsed.status).toBe(403);
    expect(parsed.level).toBe("error");
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

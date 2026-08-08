import { afterEach, describe, expect, it, vi } from "vitest";
import { MoexError, MoexProvider, parseCandles } from "../../src/analyze/providers/moex";

describe("MoexProvider.fetchCandles — retry через общий fetchWithRetry", () => {
  afterEach(() => vi.unstubAllGlobals());

  const okBody = JSON.stringify({
    candles: {
      columns: ["open", "close", "high", "low", "value", "volume", "begin"],
      data: [[100, 101, 102, 99, 0, 0, "2026-06-30 10:00:00"]],
    },
  });

  it("ретраит transient 503 затем 200, парсит свечи, creditsUsed=0", async () => {
    vi.useFakeTimers();
    let n = 0;
    const m = vi.fn(async () =>
      n++ === 0 ? new Response("err", { status: 503 }) : new Response(okBody, { status: 200 }),
    );
    vi.stubGlobal("fetch", m);
    const settled = new MoexProvider().fetchCandles("ROSN", "1h", 5).then(
      (r) => r,
      (e) => e,
    );
    await vi.runAllTimersAsync();
    const res = await settled;
    expect(m).toHaveBeenCalledTimes(2); // 503 → retry → 200 (раньше падало с 1-го раза)
    expect(res.creditsUsed).toBe(0);
    expect(res.candles).toHaveLength(1);
    expect(res.candles[0]).toMatchObject({ open: 100, close: 101, high: 102, low: 99 });
  });

  it("4xx (битый тикер) — фатально, без retry", async () => {
    const m = vi.fn(async () => new Response("Not Found", { status: 404 }));
    vi.stubGlobal("fetch", m);
    await expect(new MoexProvider().fetchCandles("NOPE", "1h", 5)).rejects.toThrow();
    expect(m).toHaveBeenCalledTimes(1);
  });
});

describe("MOEX candle validation", () => {
  it("rejects a payload without complete OHLC columns", () => {
    expect(() => parseCandles(["open", "close", "begin"], [])).toThrow(MoexError);
  });

  it("drops non-finite OHLC rows and invalid timestamps", () => {
    const columns = ["open", "close", "high", "low", "begin"];
    expect(
      parseCandles(columns, [
        [100, 101, "bad", 99, "2026-06-30 10:00:00"],
        [100, 101, 102, 99, "not-a-date"],
      ]),
    ).toEqual([]);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { MoexError, MoexProvider, parseCandles } from "../../src/analyze/providers/moex";

describe("MoexProvider.fetchCandles — retry через общий fetchWithRetry", () => {
  afterEach(() => vi.useRealTimers());

  const columns = ["open", "close", "high", "low", "value", "volume", "begin"];
  const firstCandle = [100, 101, 102, 99, 0, 0, "2026-06-30 10:00:00"];
  const okBody = JSON.stringify({ candles: { columns, data: [firstCandle] } });

  it("ретраит transient 503 затем 200, парсит свечи, creditsUsed=0", async () => {
    vi.useFakeTimers();
    let n = 0;
    const m = vi.fn(async () =>
      n++ === 0 ? new Response("err", { status: 503 }) : new Response(okBody, { status: 200 }),
    );
    const settled = new MoexProvider({ fetch: m }).fetchCandles("ROSN", "1h", 1).then(
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
    await expect(new MoexProvider({ fetch: m }).fetchCandles("NOPE", "1h", 5)).rejects.toThrow();
    expect(m).toHaveBeenCalledTimes(1);
  });

  it("fetches disjoint windows newest first and returns candles in chronological order", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-05T22:30:00Z")); // July 6 in Moscow
    const nextCandle = [101, 102, 103, 100, 0, 0, "2026-07-01 10:00:00"];
    const fetch = vi.fn(async (url: string) => {
      const till = new URL(url).searchParams.get("till");
      const data = till === "2026-07-06" ? [nextCandle] : [firstCandle];
      return Response.json({ candles: { columns, data } });
    });
    const result = await new MoexProvider({ fetch }).fetchCandles("ROSN", "1h", 2);
    const queries = fetch.mock.calls.map(([url]) => Object.fromEntries(new URL(url).searchParams));
    const candleQuery = {
      interval: "60",
      "iss.meta": "off",
      "iss.only": "candles",
      "candles.columns": "open,close,high,low,begin",
    };
    expect(queries).toEqual([
      { ...candleQuery, from: "2026-07-01", till: "2026-07-06" },
      { ...candleQuery, from: "2026-06-25", till: "2026-06-30" },
    ]);
    expect(result.candles.map((candle) => candle.datetime)).toEqual([
      "2026-06-30T07:00:00.000Z",
      "2026-07-01T07:00:00.000Z",
    ]);
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

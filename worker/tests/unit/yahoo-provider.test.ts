import { afterEach, describe, expect, it, vi } from "vitest";
import { YahooProvider, parseYahooChart, toYahooSymbol } from "../../src/analyze/providers/yahoo";

// Структура Yahoo v8 chart — захвачена с query1.finance.yahoo.com/v8/finance/chart/SI=F.
function makePayload(q: {
  timestamp: number[];
  open: (number | null)[];
  high: (number | null)[];
  low: (number | null)[];
  close: (number | null)[];
}) {
  return {
    chart: {
      result: [
        {
          meta: { currency: "USD", symbol: "SI=F" },
          timestamp: q.timestamp,
          indicators: { quote: [{ open: q.open, high: q.high, low: q.low, close: q.close }] },
        },
      ],
      error: null,
    },
  };
}

describe("parseYahooChart", () => {
  it("парсит timestamp+OHLC в Candle[] (ISO UTC)", () => {
    const candles = parseYahooChart(
      makePayload({
        timestamp: [1781150400, 1781236800, 1781323200],
        open: [63.95, 67.04, 70.0],
        high: [63.98, 68.08, 70.5],
        low: [63.88, 67.02, 69.5],
        close: [63.88, 67.86, 70.07],
      }),
    );
    expect(candles).toEqual([
      { datetime: "2026-06-11T04:00:00.000Z", open: 63.95, high: 63.98, low: 63.88, close: 63.88 },
      { datetime: "2026-06-12T04:00:00.000Z", open: 67.04, high: 68.08, low: 67.02, close: 67.86 },
      { datetime: "2026-06-13T04:00:00.000Z", open: 70.0, high: 70.5, low: 69.5, close: 70.07 },
    ]);
  });

  it("пропускает точки с null (дыры Yahoo)", () => {
    const candles = parseYahooChart(
      makePayload({
        timestamp: [1781150400, 1781236800, 1781323200],
        open: [63.95, null, 70.0],
        high: [63.98, null, 70.5],
        low: [63.88, null, 69.5],
        close: [63.88, null, 70.07],
      }),
    );
    expect(candles.map((c) => c.datetime)).toEqual([
      "2026-06-11T04:00:00.000Z",
      "2026-06-13T04:00:00.000Z",
    ]);
  });

  it("кидает на пустой/битый payload", () => {
    expect(() =>
      parseYahooChart({ chart: { result: null, error: { description: "Not Found" } } }),
    ).toThrow();
  });
});

describe("toYahooSymbol", () => {
  it("маппит металлы на фьючерсные тикеры", () => {
    expect(toYahooSymbol("XAG/USD")).toBe("SI=F");
    expect(toYahooSymbol("XAU/USD")).toBe("GC=F");
  });
  it("регистронезависим", () => {
    expect(toYahooSymbol("xag/usd")).toBe("SI=F");
  });
  it("возвращает null для не-металла", () => {
    expect(toYahooSymbol("AAPL")).toBeNull();
    expect(toYahooSymbol("EUR/USD")).toBeNull();
  });
});

describe("YahooProvider.resolveSymbol", () => {
  it("резолвит металл как commodity/USD", async () => {
    const r = await new YahooProvider().resolveSymbol("XAG/USD");
    expect(r).not.toBeNull();
    expect(r?.symbol).toBe("XAG/USD");
    expect(r?.type).toBe("commodity");
    expect(r?.currency).toBe("USD");
    expect((r?.display_name.length ?? 0) > 0).toBe(true);
  });
  it("возвращает null для неизвестного символа", async () => {
    expect(await new YahooProvider().resolveSymbol("AAPL")).toBeNull();
  });
});

describe("parseYahooChart — edge cases (упрочнение)", () => {
  it("частичный null (open=null, остальное valid) — точка отбрасывается целиком", () => {
    const c = parseYahooChart(
      makePayload({
        timestamp: [1781150400, 1781236800],
        open: [null, 70.0],
        high: [63.98, 70.5],
        low: [63.88, 69.5],
        close: [63.88, 70.07],
      }),
    );
    expect(c.map((x) => x.datetime)).toEqual(["2026-06-12T04:00:00.000Z"]);
  });

  it("отбрасывает NaN-точки — finite-гард на ВСЕХ OHLC, включая high/low", () => {
    const c = parseYahooChart(
      makePayload({
        timestamp: [1781150400, 1781236800],
        open: [1, 2],
        high: [Number.NaN, 2], // high=NaN на idx0 — раньше проскакивало (чек был только open/close)
        low: [1, 2],
        close: [1, 2],
      }),
    );
    expect(c).toHaveLength(1);
    expect(c[0].datetime).toBe("2026-06-12T04:00:00.000Z");
  });

  it("все точки null при наличии timestamp — кидает (не возвращает [] молча, не перетирает good-state)", () => {
    expect(() =>
      parseYahooChart(
        makePayload({
          timestamp: [1781150400, 1781236800],
          open: [null, null],
          high: [null, null],
          low: [null, null],
          close: [null, null],
        }),
      ),
    ).toThrow();
  });

  it("пустой timestamp (нет данных в окне) — кидает (нет пригодных свечей)", () => {
    expect(() =>
      parseYahooChart(makePayload({ timestamp: [], open: [], high: [], low: [], close: [] })),
    ).toThrow();
  });
});

describe("YahooProvider.fetchCandles (fetch-spy)", () => {
  afterEach(() => vi.unstubAllGlobals());

  const okPayload = (n: number) =>
    JSON.stringify(
      makePayload({
        timestamp: [1781150400, 1781236800, 1781323200].slice(0, n),
        open: [1, 2, 3].slice(0, n),
        high: [1, 2, 3].slice(0, n),
        low: [1, 2, 3].slice(0, n),
        close: [10, 20, 30].slice(0, n),
      }),
    );

  it("кодирует = в тикере (SI%3DF), верный range/interval, creditsUsed=0, slice до count", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        urls.push(String(url));
        return new Response(okPayload(3), { status: 200 });
      }),
    );
    const res = await new YahooProvider().fetchCandles("XAG/USD", "1day", 2);
    expect(urls[0]).toContain("/SI%3DF?"); // '=' закодирован, иначе Yahoo вернёт не тот инструмент
    expect(urls[0]).toContain("interval=1d");
    expect(urls[0]).toContain("range=2y");
    expect(res.creditsUsed).toBe(0); // Yahoo бесплатен — не жжёт TwelveData-квоту
    expect(res.candles).toHaveLength(2); // slice(-2) из 3
    expect(res.candles[1].close).toBe(30);
  });

  it("4xx (не 429) — фатально, без retry", async () => {
    const fetchMock = vi.fn(async () => new Response("Not Found", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(new YahooProvider().fetchCandles("XAG/USD", "1day", 5)).rejects.toThrow(/404/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("429 — retryable, ретраит и кидает после исчерпания попыток", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response("rate limited", { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    const settled = new YahooProvider().fetchCandles("XAU/USD", "1h", 50).then(
      () => "resolved",
      (e) => `rejected:${String(e)}`,
    );
    await vi.runAllTimersAsync();
    const outcome = await settled;
    expect(outcome).toContain("rejected");
    expect(outcome).toMatch(/429/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it("transient 503 затем 200 — ретраит и возвращает данные", async () => {
    vi.useFakeTimers();
    let n = 0;
    const fetchMock = vi.fn(async () => {
      n += 1;
      return n === 1
        ? new Response("upstream error", { status: 503 })
        : new Response(okPayload(2), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const settled = new YahooProvider().fetchCandles("XAG/USD", "1day", 5).then(
      (r) => r,
      (e) => e,
    );
    await vi.runAllTimersAsync();
    const res = await settled;
    expect(res.creditsUsed).toBe(0);
    expect(res.candles).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});

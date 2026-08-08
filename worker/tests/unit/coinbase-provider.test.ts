import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CoinbaseProvider,
  parseCoinbaseCandles,
  toCoinbaseProduct,
} from "../../src/analyze/providers/coinbase";

describe("toCoinbaseProduct", () => {
  it("BTC/USD → BTC-USD", () => {
    expect(toCoinbaseProduct("BTC/USD")).toBe("BTC-USD");
  });
  it("регистронезависим: eth/usd → ETH-USD", () => {
    expect(toCoinbaseProduct("eth/usd")).toBe("ETH-USD");
  });
  it("без слэша → null", () => {
    expect(toCoinbaseProduct("AAPL")).toBeNull();
  });
});

describe("parseCoinbaseCandles", () => {
  // Coinbase отдаёт [time, low, high, open, close, volume], DESCENDING (newest first).
  it("парсит, сортирует ascending, верный маппинг low/high/open/close", () => {
    const c = parseCoinbaseCandles([
      [1781150400, 10, 20, 12, 18, 100], // 04:00 (newest)
      [1781146800, 5, 15, 8, 14, 200], // 03:00
    ]);
    expect(c).toEqual([
      { datetime: "2026-06-11T03:00:00.000Z", open: 8, high: 15, low: 5, close: 14 },
      { datetime: "2026-06-11T04:00:00.000Z", open: 12, high: 20, low: 10, close: 18 },
    ]);
  });

  it("пропускает точки с null/non-finite", () => {
    const c = parseCoinbaseCandles([
      [1781150400, 10, 20, 12, 18, 100],
      [1781146800, null, 15, 8, 14, 200],
    ]);
    expect(c.map((x) => x.datetime)).toEqual(["2026-06-11T04:00:00.000Z"]);
  });

  it("0 пригодных свечей — кидает (не возвращает [] молча)", () => {
    expect(() => parseCoinbaseCandles([])).toThrow();
  });
});

describe("CoinbaseProvider.fetchCandles (fetch-spy)", () => {
  afterEach(() => vi.unstubAllGlobals());

  const okBody = JSON.stringify([
    [1781150400, 10, 20, 12, 18, 100],
    [1781146800, 5, 15, 8, 14, 200],
    [1781143200, 1, 9, 3, 7, 300],
  ]);

  it("строит /products/BTC-USD/candles?granularity=3600, creditsUsed=0, slice", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        urls.push(String(url));
        return new Response(okBody, { status: 200 });
      }),
    );
    const res = await new CoinbaseProvider().fetchCandles("BTC/USD", "1h", 2);
    expect(urls[0]).toContain("/products/BTC-USD/candles");
    expect(urls[0]).toContain("granularity=3600");
    expect(res.creditsUsed).toBe(0);
    expect(res.candles).toHaveLength(2); // slice(-2) из 3
  });

  it("1day → granularity=86400", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        urls.push(String(url));
        return new Response(okBody, { status: 200 });
      }),
    );
    await new CoinbaseProvider().fetchCandles("ETH/USD", "1day", 3);
    expect(urls[0]).toContain("/products/ETH-USD/candles");
    expect(urls[0]).toContain("granularity=86400");
  });

  it("символ без слэша — кидает (не построить product)", async () => {
    await expect(new CoinbaseProvider().fetchCandles("AAPL", "1h", 5)).rejects.toThrow();
  });
});

describe("CoinbaseProvider.resolveSymbol", () => {
  it("возвращает null — Coinbase у нас только фетчит (resolve через TwelveData)", async () => {
    expect(await new CoinbaseProvider().resolveSymbol("BTC/USD")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { getProvider, getProviderForAsset, guessProvider } from "../../src/analyze/providers";
import { CoinbaseProvider } from "../../src/analyze/providers/coinbase";
import { MoexProvider } from "../../src/analyze/providers/moex";
import {
  TwelveDataProvider,
  classifyType,
  resolveCurrency,
} from "../../src/analyze/providers/twelvedata";
import { YahooProvider } from "../../src/analyze/providers/yahoo";
import type { Asset } from "../../src/state/schema";

function asset(over: Partial<Asset>): Asset {
  return {
    symbol: "EUR/USD",
    display_name: "x",
    type: "forex",
    provider: "twelvedata",
    currency: "USD",
    active: true,
    added_at: "2026-06-16T00:00:00Z",
    ...over,
  };
}

describe("getProviderForAsset — металлы→Yahoo, крипта→Coinbase, остальное по stored", () => {
  it("металл → YahooProvider (по символу, независимо от stored provider)", () => {
    // XAG/USD хранится как provider=twelvedata (CHECK не трогаем), но фетч — Yahoo.
    const p = getProviderForAsset(asset({ symbol: "XAG/USD", provider: "twelvedata" }), "k");
    expect(p).toBeInstanceOf(YahooProvider);
  });
  it("крипта → CoinbaseProvider (по type, независимо от stored provider)", () => {
    // BTC/USD хранится как provider=twelvedata, но фетч — Coinbase (разгрузка квоты).
    const p = getProviderForAsset(
      asset({ symbol: "BTC/USD", type: "crypto", provider: "twelvedata" }),
      "k",
    );
    expect(p).toBeInstanceOf(CoinbaseProvider);
  });
  it("forex → TwelveDataProvider (по stored provider)", () => {
    expect(
      getProviderForAsset(asset({ symbol: "EUR/USD", provider: "twelvedata" }), "k"),
    ).toBeInstanceOf(TwelveDataProvider);
  });
  it("RU-акция → MoexProvider (по stored provider)", () => {
    expect(
      getProviderForAsset(asset({ symbol: "LKOH", type: "stock_ru", provider: "moex" }), "k"),
    ).toBeInstanceOf(MoexProvider);
  });
});

describe("getProvider", () => {
  it("конструирует провайдер по имени", () => {
    expect(getProvider("moex", "")).toBeInstanceOf(MoexProvider);
    expect(getProvider("twelvedata", "k")).toBeInstanceOf(TwelveDataProvider);
  });
});

describe("guessProvider", () => {
  it("известные RU тикеры → moex", () => {
    expect(guessProvider("LKOH")).toBe("moex");
    expect(guessProvider("SBER")).toBe("moex");
  });
  it("остальное → twelvedata (металлы резолвятся через TD symbol_search)", () => {
    expect(guessProvider("AAPL")).toBe("twelvedata");
    expect(guessProvider("XAG/USD")).toBe("twelvedata");
  });
});

describe("classifyType", () => {
  it("Digital Currency → crypto (был баг: 'currency' матчился forex'ом первым)", () => {
    expect(classifyType("Digital Currency")).toBe("crypto");
  });
  it("Physical Currency → forex (а вот это именно forex)", () => {
    expect(classifyType("Physical Currency")).toBe("forex");
  });
  it("Precious Metal → commodity (был баг: падал в stock_us)", () => {
    expect(classifyType("Precious Metal")).toBe("commodity");
  });
  it("Common Stock → stock_us", () => {
    expect(classifyType("Common Stock")).toBe("stock_us");
  });
});

describe("resolveCurrency — fallback пустой currency (крипта TwelveData)", () => {
  it("непустую оставляет", () => {
    expect(resolveCurrency("USD", "AAPL")).toBe("USD");
    expect(resolveCurrency("RUB", "LKOH")).toBe("RUB");
  });
  it("пустую → quote-часть символа (BTC/USD → USD, BTC/EUR → EUR)", () => {
    expect(resolveCurrency("", "BTC/USD")).toBe("USD");
    expect(resolveCurrency("", "BTC/EUR")).toBe("EUR");
  });
  it("пустую без слэша → USD", () => {
    expect(resolveCurrency("", "AAPL")).toBe("USD");
  });
});

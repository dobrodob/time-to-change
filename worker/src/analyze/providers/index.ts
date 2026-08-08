/**
 * Provider factory.
 *
 * Используется в analyze cron и в /subscribe handler для resolve symbol.
 */
import type { Asset, AssetProvider } from "../../state/schema";
import { CoinbaseProvider } from "./coinbase";
import { MoexProvider } from "./moex";
import { TwelveDataProvider } from "./twelvedata";
import type { PriceProvider, ResolvedSymbol } from "./types";
import { YahooProvider, toYahooSymbol } from "./yahoo";

export { TwelveDataError, TwelveDataQuotaError } from "./twelvedata";
export { MoexError } from "./moex";
export { YahooError } from "./yahoo";
export type { FetchResult, Interval, PriceProvider, ResolvedSymbol } from "./types";

export function getProvider(provider: AssetProvider, twelvedataApiKey: string): PriceProvider {
  switch (provider) {
    case "twelvedata":
      return new TwelveDataProvider(twelvedataApiKey);
    case "moex":
      return new MoexProvider();
  }
}

export function getProviderForAsset(asset: Asset, twelvedataApiKey: string): PriceProvider {
  // Металлы → Yahoo (по символу), крипта → Coinbase (по типу). Оба фетчат мимо
  // TwelveData: металлы она на free-tier не отдаёт, а крипту мы уводим, чтобы
  // разгрузить её квоту (creditsUsed=0). Stored provider у них остаётся
  // twelvedata/moex: provider CHECK НЕ трогаем, т.к. rebuild таблицы assets
  // каскадит DELETE по FK (subscriptions/asset_state) — проверено локально.
  if (toYahooSymbol(asset.symbol) !== null) return new YahooProvider();
  if (asset.type === "crypto") return new CoinbaseProvider();
  return getProvider(asset.provider, twelvedataApiKey);
}

/**
 * Эвристика: какой provider должен resolve этот symbol?
 * Используется в /subscribe когда asset ещё не в registry.
 *
 * Правила:
 *   - содержит "/" (например "EUR/USD", "BTC/USD") → forex/crypto → twelvedata
 *   - заглавные латинские 1-5 символов (AAPL, TSLA, BTC) → US stock / crypto → twelvedata
 *   - заглавные латинские 4-5 символов начинающиеся с распространённых RU prefix
 *     (LKOH, GAZP, SBER, ROSN, MGNT, VKCO, YDEX, ...) → MOEX
 *
 * Если эвристика не уверена — пробуем оба, кто первый resolve'нет.
 */
const KNOWN_MOEX_SYMBOLS = new Set([
  "LKOH",
  "GAZP",
  "SBER",
  "SBERP",
  "ROSN",
  "MGNT",
  "TATN",
  "SNGS",
  "NVTK",
  "GMKN",
  "MOEX",
  "VTBR",
  "ALRS",
  "PLZL",
  "MTSS",
  "RUAL",
  "AFLT",
  "NLMK",
  "YDEX",
  "VKCO",
  "PHOR",
  "POLY",
  "POSI",
  "CHMF",
  "FIVE",
  "OZON",
  "PIKK",
  "AFKS",
  "TCSG",
  "FEES",
]);

export function guessProvider(symbol: string): AssetProvider {
  const upper = symbol.toUpperCase();
  if (KNOWN_MOEX_SYMBOLS.has(upper)) return "moex";
  return "twelvedata";
}

/**
 * Resolve symbol через guessed provider, на ошибку — fallback к alternative.
 *
 * Драгметаллы (XAG/XAU/…) резолвятся через TwelveData symbol_search (оно отдаёт
 * метаданные "Precious Metal" → commodity), а фетчатся через Yahoo — см.
 * getProviderForAsset. Stored provider у них остаётся twelvedata.
 */
export async function resolveSymbolAuto(
  rawSymbol: string,
  twelvedataApiKey: string,
): Promise<{ resolved: ResolvedSymbol; provider: AssetProvider } | null> {
  const guessed = guessProvider(rawSymbol);
  const alternative: AssetProvider = guessed === "twelvedata" ? "moex" : "twelvedata";
  for (const prov of [guessed, alternative]) {
    const provider = getProvider(prov, twelvedataApiKey);
    const resolved = await provider.resolveSymbol(rawSymbol);
    if (resolved) return { resolved, provider: prov };
  }
  return null;
}

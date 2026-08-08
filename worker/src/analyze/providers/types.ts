/**
 * Provider abstraction для multi-asset support.
 *
 * Каждый provider знает как fetch OHLC candles из своего API:
 *   - TwelveDataProvider: forex, US stocks, crypto, commodities (auth via TWELVEDATA_API_KEY)
 *   - MoexProvider: RU stocks (без auth, free ISS API)
 *
 * Market hours логика отделена — см. `analyze/market-calendar.ts:isMarketOpenForType()`.
 */
import type { AssetType } from "../../state/schema";
import type { Candle } from "../scoring";

export type Interval = "1h" | "1day";

export interface FetchResult {
  candles: Candle[];
  /** Credits consumed by this fetch (0 for free providers like MOEX). */
  creditsUsed: number;
}

export interface PriceProvider {
  /** Тянет candles. Возвращает chronologically ascending. */
  fetchCandles(symbol: string, interval: Interval, count: number): Promise<FetchResult>;

  /** Validate symbol — провайдер знает свои тикеры. Возвращает display info + currency. */
  resolveSymbol(symbol: string): Promise<ResolvedSymbol | null>;
}

export interface ResolvedSymbol {
  symbol: string; // canonical (например "EUR/USD" а не "EURUSD")
  display_name: string; // "Apple Inc.", "Лукойл"
  type: AssetType; // классификация
  currency: string; // валюта котировки ("USD", "RUB")
}

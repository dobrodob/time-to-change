/**
 * Coinbase Exchange provider — криптовалюты (BTC/USD, ETH/USD, ...).
 *
 * Зачем: лучший биржевой OHLC для крипты, бесплатно, без ключа, и — в отличие
 * от Binance — глобально доступен из CF Worker (Binance.com блокирует US-IP, а
 * edge воркера часто геолоцируется в US → 451). Фетч мимо TwelveData разгружает
 * её квоту (creditsUsed=0).
 *
 * Endpoint:
 *   GET /products/{BASE-QUOTE}/candles?granularity={3600|86400}
 * Response:
 *   [[time(sec), low, high, open, close, volume], ...]  — DESCENDING (newest first)
 */
import { fetchWithRetry } from "../../lib/http";
import type { Candle } from "../scoring";
import type { FetchResult, Interval, PriceProvider, ResolvedSymbol } from "./types";

const BASE_URL = "https://api.exchange.coinbase.com";
const GRANULARITY: Record<Interval, number> = { "1day": 86400, "1h": 3600 };

export class CoinbaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoinbaseError";
  }
}

/** "BTC/USD" → "BTC-USD" (Coinbase product id), либо null если нет "/". */
export function toCoinbaseProduct(symbol: string): string | null {
  const upper = symbol.toUpperCase();
  return upper.includes("/") ? upper.replace("/", "-") : null;
}

/**
 * Чистый парсинг Coinbase candles → Candle[] (ascending).
 * Строка: [time(sec), low, high, open, close, volume]. Источник отдаёт
 * descending → сортируем ascending. Кидает на 0 пригодных свечей (не возвращает
 * [] молча — иначе перетёрло бы good-state нулевым/NaN-срезом).
 */
export function parseCoinbaseCandles(payload: unknown): Candle[] {
  if (!Array.isArray(payload)) {
    throw new CoinbaseError("Unexpected Coinbase payload");
  }
  const candles: Candle[] = [];
  for (const row of payload) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const [time, low, high, open, close] = row as (number | null)[];
    if (time == null || low == null || high == null || open == null || close == null) continue;
    if (![time, open, high, low, close].every((v) => Number.isFinite(v))) continue;
    const timestamp = new Date(time * 1000);
    if (!Number.isFinite(timestamp.getTime())) continue;
    candles.push({ datetime: timestamp.toISOString(), open, high, low, close });
  }
  if (candles.length === 0) {
    throw new CoinbaseError("Coinbase вернул ответ без пригодных OHLC-свечей");
  }
  candles.sort((a, b) => a.datetime.localeCompare(b.datetime));
  return candles;
}

export class CoinbaseProvider implements PriceProvider {
  async fetchCandles(symbol: string, interval: Interval, count: number): Promise<FetchResult> {
    const product = toCoinbaseProduct(symbol);
    if (product === null) throw new CoinbaseError(`Unsupported Coinbase symbol: ${symbol}`);
    // Без start/end Coinbase отдаёт последние ~300 свечей — берём, потом trim до count.
    const url = `${BASE_URL}/products/${encodeURIComponent(product)}/candles?granularity=${GRANULARITY[interval]}`;
    const res = await fetchWithRetry(url);
    const payload = await res.json();
    const candles = parseCoinbaseCandles(payload).slice(-count);
    return { candles, creditsUsed: 0 };
  }

  async resolveSymbol(_symbol: string): Promise<ResolvedSymbol | null> {
    // Coinbase у нас только фетчит; resolve крипты идёт через TwelveData
    // symbol_search (classifyType → crypto). Stored provider остаётся twelvedata.
    return null;
  }
}

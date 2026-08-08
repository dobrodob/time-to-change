/**
 * Yahoo Finance provider — драгметаллы (серебро/золото/платина/палладий).
 *
 * Зачем отдельный провайдер: TwelveData Basic ($0) НЕ покрывает commodities
 * (нужен план Grow $79/мес), поэтому XAG/USD там не фетчится. Yahoo v8 chart
 * отдаёт OHLC бесплатно и без ключа.
 *
 * Источник — фьючерсные тикеры COMEX/NYMEX (SI=F, GC=F, …): они трекают спот
 * с базисом ~0.03% (проверено: SI=F 69.9 против gold-api спот 69.876), чего
 * с запасом достаточно для momentum/percentile-скоринга.
 *
 * Endpoint:
 *   GET /v8/finance/chart/{ySym}?interval={1d|1h}&range={2y|3mo}
 * Response:
 *   { chart: { result: [{ timestamp: number[],
 *       indicators: { quote: [{ open[], high[], low[], close[] }] } }], error } }
 * Дыры в данных приходят как null в массивах — пропускаем такие точки.
 */
import { fetchWithRetry } from "../../lib/http";
import type { Candle } from "../scoring";
import type { FetchResult, Interval, PriceProvider, ResolvedSymbol } from "./types";

const BASE_URL = "https://query1.finance.yahoo.com/v8/finance/chart";

/** Canonical метал-символ → Yahoo фьючерсный тикер + display_name. */
const METALS: Record<string, { yahoo: string; name: string }> = {
  "XAG/USD": { yahoo: "SI=F", name: "Серебро (XAG/USD)" },
  "XAU/USD": { yahoo: "GC=F", name: "Золото (XAU/USD)" },
  "XPT/USD": { yahoo: "PL=F", name: "Платина (XPT/USD)" },
  "XPD/USD": { yahoo: "PA=F", name: "Палладий (XPD/USD)" },
};

const INTERVAL_MAP: Record<Interval, string> = { "1day": "1d", "1h": "1h" };

export class YahooError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YahooError";
  }
}

/** Метал-символ → Yahoo тикер, либо null если символ не из набора металлов. */
export function toYahooSymbol(symbol: string): string | null {
  return METALS[symbol.toUpperCase()]?.yahoo ?? null;
}

interface YahooQuote {
  open?: (number | null)[];
  high?: (number | null)[];
  low?: (number | null)[];
  close?: (number | null)[];
}
interface YahooResult {
  timestamp?: number[];
  indicators?: { quote?: YahooQuote[] };
}
interface YahooPayload {
  chart?: { result?: YahooResult[] | null; error?: unknown };
}

/**
 * Чистый парсинг Yahoo chart payload → Candle[] (ascending по времени).
 * Пропускает точки с null OHLC (дыры). Кидает YahooError на пустой/битый ответ.
 */
export function parseYahooChart(payload: unknown): Candle[] {
  const result = (payload as YahooPayload)?.chart?.result;
  if (!Array.isArray(result) || result.length === 0) {
    throw new YahooError(`Empty/invalid Yahoo payload: ${JSON.stringify(payload).slice(0, 200)}`);
  }
  const r = result[0];
  const ts = r.timestamp;
  const q = r.indicators?.quote?.[0];
  if (!Array.isArray(ts) || !q) {
    throw new YahooError("Yahoo result missing timestamp/quote");
  }
  const candles: Candle[] = [];
  for (let i = 0; i < ts.length; i++) {
    const open = q.open?.[i];
    const high = q.high?.[i];
    const low = q.low?.[i];
    const close = q.close?.[i];
    if (open == null || high == null || low == null || close == null) continue;
    // finite-гард на ВСЕ четыре OHLC: NaN/Infinity в high/low отравил бы ATR.
    if (![open, high, low, close].every((v) => Number.isFinite(v))) continue;
    candles.push({ datetime: new Date(ts[i] * 1000).toISOString(), open, high, low, close });
  }
  // Ноль пригодных свечей (все точки null / пустой timestamp) — это сбой фида, а
  // не валидный «нет данных»: кидаем, чтобы analyze пометил asset_failed (видно в
  // логах) и НЕ перетёр последний хороший last_score_breakdown нулевым/NaN-срезом.
  if (candles.length === 0) {
    throw new YahooError("Yahoo вернул ответ без пригодных OHLC-свечей");
  }
  candles.sort((a, b) => a.datetime.localeCompare(b.datetime));
  return candles;
}

export class YahooProvider implements PriceProvider {
  async fetchCandles(symbol: string, interval: Interval, count: number): Promise<FetchResult> {
    const ySym = toYahooSymbol(symbol);
    if (ySym === null) throw new YahooError(`Unsupported Yahoo symbol: ${symbol}`);
    // range — валидные enum-токены Yahoo. Берём с запасом, потом trim до count.
    const range = interval === "1day" ? "2y" : "3mo";
    const url = `${BASE_URL}/${encodeURIComponent(ySym)}?interval=${INTERVAL_MAP[interval]}&range=${range}`;
    const res = await fetchWithRetry(url);
    const payload = await res.json();
    const candles = parseYahooChart(payload).slice(-count);
    return { candles, creditsUsed: 0 };
  }

  async resolveSymbol(symbol: string): Promise<ResolvedSymbol | null> {
    const meta = METALS[symbol.toUpperCase()];
    if (!meta) return null;
    return {
      symbol: symbol.toUpperCase(),
      display_name: meta.name,
      type: "commodity",
      currency: "USD",
    };
  }
}

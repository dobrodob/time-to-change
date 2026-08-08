/**
 * TwelveData provider — forex + US stocks + crypto + commodities + indices.
 *
 * Refactored из старого analyze/twelvedata.ts → implements PriceProvider interface.
 * Free tier: 800 calls/day, 8/min.
 */
import { log } from "../../lib/log";
import type { AssetType } from "../../state/schema";
import type { Candle } from "../scoring";
import type { FetchResult, Interval, PriceProvider, ResolvedSymbol } from "./types";

const BASE_URL = "https://api.twelvedata.com";

export class TwelveDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TwelveDataError";
  }
}

export class TwelveDataQuotaError extends TwelveDataError {
  constructor(message: string) {
    super(message);
    this.name = "TwelveDataQuotaError";
  }
}

interface TwelveValue {
  datetime: string;
  open: string;
  high: string;
  low: string;
  close: string;
}

interface TwelvePayload {
  status?: string;
  code?: number;
  message?: string;
  values?: TwelveValue[];
}

interface SymbolSearchResult {
  data?: Array<{
    symbol: string;
    instrument_name: string;
    exchange: string;
    currency: string;
    instrument_type: string;
  }>;
}

export class TwelveDataProvider implements PriceProvider {
  constructor(private readonly apiKey: string) {}

  async fetchCandles(symbol: string, interval: Interval, count: number): Promise<FetchResult> {
    return fetchTimeSeries(this.apiKey, symbol, interval, count);
  }

  async resolveSymbol(symbol: string): Promise<ResolvedSymbol | null> {
    // TwelveData /symbol_search возвращает близкие matches.
    const params = new URLSearchParams({ symbol, outputsize: "5" });
    const url = `${BASE_URL}/symbol_search?${params.toString()}`;
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const payload = (await res.json()) as SymbolSearchResult;
      const matches = payload.data ?? [];
      // Точный match по symbol — приоритет.
      const exact = matches.find((m) => m.symbol.toUpperCase() === symbol.toUpperCase());
      const m = exact ?? matches[0];
      if (!m) return null;
      return {
        symbol: m.symbol.toUpperCase(),
        display_name: m.instrument_name,
        type: classifyType(m.instrument_type),
        currency: resolveCurrency(m.currency, m.symbol),
      };
    } catch (err) {
      log("warn", "twelvedata_resolve_failed", { symbol, error: String(err).slice(0, 200) });
      return null;
    }
  }
}

export function classifyType(instrumentType: string): AssetType {
  const t = instrumentType.toLowerCase();
  // crypto ПЕРЕД currency: TwelveData отдаёт "Digital Currency" для крипты, а это
  // содержит подстроку "currency" → без приоритета BTC/USD попал бы в forex
  // (неверные часы/веса/эмодзи + не роутился бы на Coinbase).
  if (t.includes("crypto") || t.includes("digital")) return "crypto";
  if (t.includes("currency") || t.includes("forex")) return "forex";
  // "commodity" + "metal": TwelveData отдаёт "Precious Metal" для XAU/XAG —
  // раньше это падало в дефолтный stock_us (чужой эмодзи, часы NYSE, неверные
  // веса). Металлы теперь идут через Yahoo, но классификатор не должен лгать.
  if (t.includes("commodity") || t.includes("metal")) return "commodity";
  if (t.includes("index")) return "index";
  return "stock_us";
}

/**
 * TwelveData отдаёт пустую currency для крипты ("BTC/USD" → ""). Fallback на
 * quote-часть символа (после "/"), иначе "USD" — иначе assetSchema.currency.min(1)
 * упал бы при getAsset, и крипто-подписка сломалась бы на чтении.
 */
export function resolveCurrency(rawCurrency: string, symbol: string): string {
  if (rawCurrency) return rawCurrency;
  const quote = symbol.includes("/") ? symbol.split("/")[1] : "";
  return quote ? quote.toUpperCase() : "USD";
}

export async function fetchTimeSeries(
  apiKey: string,
  symbol: string,
  interval: Interval,
  outputsize: number,
  maxRetries = 3,
): Promise<FetchResult> {
  const params = new URLSearchParams({
    symbol,
    interval,
    outputsize: String(outputsize),
    apikey: apiKey,
    order: "asc",
    timezone: "UTC",
    format: "JSON",
  });
  const url = `${BASE_URL}/time_series?${params.toString()}`;

  let delayMs = 2000;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 429) throw new TwelveDataQuotaError("Rate limit (HTTP 429)");
      if (!res.ok) throw new TwelveDataError(`HTTP ${res.status}: ${await res.text()}`);

      const payload = (await res.json()) as TwelvePayload;

      if (payload.status === "error") {
        const code = payload.code;
        const msg = payload.message ?? "unknown error";
        if (code === 429 || code === 401 || code === 402) {
          throw new TwelveDataQuotaError(`API quota error ${code}: ${msg}`);
        }
        throw new TwelveDataError(`API error ${code}: ${msg}`);
      }
      if (!Array.isArray(payload.values)) {
        throw new TwelveDataError(`Unexpected payload: ${JSON.stringify(payload).slice(0, 200)}`);
      }

      const candles = parseValues(payload.values);
      const creditsUsed = creditsFromHeaders(res.headers, 1);
      return { candles, creditsUsed };
    } catch (err) {
      lastErr = err;
      if (err instanceof TwelveDataQuotaError) throw err;
      log("warn", "twelvedata_attempt_failed", { attempt, error: String(err).slice(0, 200) });
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, delayMs));
        delayMs *= 2;
      }
    }
  }
  throw new TwelveDataError(`All ${maxRetries} attempts failed: ${lastErr}`);
}

function parseValues(values: TwelveValue[]): Candle[] {
  const candles: Candle[] = values.map((v) => ({
    datetime: v.datetime,
    open: Number.parseFloat(v.open),
    high: Number.parseFloat(v.high),
    low: Number.parseFloat(v.low),
    close: Number.parseFloat(v.close),
  }));
  candles.sort((a, b) => a.datetime.localeCompare(b.datetime));
  return candles;
}

function creditsFromHeaders(headers: Headers, fallback: number): number {
  for (const name of ["api-credits-used", "x-api-credits-used"]) {
    const v = headers.get(name);
    if (v !== null) {
      const n = Number.parseInt(v, 10);
      if (Number.isFinite(n)) return n;
    }
  }
  return fallback;
}

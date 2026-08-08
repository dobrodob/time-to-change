/**
 * TwelveData provider — forex + US stocks + crypto + commodities + indices.
 *
 * Refactored из старого analyze/twelvedata.ts → implements PriceProvider interface.
 * Free tier: 800 calls/day, 8/min.
 */
import { errorKind, log } from "../../lib/log";
import type { AssetType } from "../../state/schema";
import type { Candle } from "../scoring";
import type { FetchResult, Interval, PriceProvider, ResolvedSymbol } from "./types";

const BASE_URL = "https://api.twelvedata.com";
const REQUEST_TIMEOUT_MS = 8000;

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
      const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!res.ok) return null;
      const payload = (await res.json()) as SymbolSearchResult;
      const matches = payload.data ?? [];
      // Точный match по symbol — приоритет.
      const exact = matches.find((m) => m.symbol.toUpperCase() === symbol.toUpperCase());
      const m = exact ?? matches[0];
      if (!m) return null;
      return {
        symbol: m.symbol.toUpperCase(),
        display_name: m.instrument_name || m.symbol,
        type: classifyType(m.instrument_type),
        currency: resolveCurrency(m.currency, m.symbol),
      };
    } catch (err) {
      log("warn", "twelvedata_resolve_failed", { symbol, error_kind: errorKind(err) });
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
      const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.status === 429) throw new TwelveDataQuotaError("Rate limit (HTTP 429)");
      if (!res.ok) throw new TwelveDataError(`HTTP ${res.status}`);

      const payload = (await res.json()) as TwelvePayload;

      if (payload.status === "error") {
        const code = payload.code;
        if (code === 429 || code === 401 || code === 402) {
          throw new TwelveDataQuotaError(`API quota error ${code ?? "unknown"}`);
        }
        throw new TwelveDataError(`API error ${code ?? "unknown"}`);
      }
      if (!Array.isArray(payload.values)) {
        throw new TwelveDataError("Unexpected payload");
      }

      const candles = parseValues(payload.values);
      if (candles.length === 0) throw new TwelveDataError("No valid candles");
      const creditsUsed = creditsFromHeaders(res.headers, 1);
      return { candles, creditsUsed };
    } catch (err) {
      lastErr = err;
      if (err instanceof TwelveDataQuotaError) throw err;
      log("warn", "twelvedata_attempt_failed", { attempt, error_kind: errorKind(err) });
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, delayMs));
        delayMs *= 2;
      }
    }
  }
  throw new TwelveDataError(
    `All ${maxRetries} attempts failed (${errorKind(lastErr)})`,
  );
}

export function parseValues(values: TwelveValue[]): Candle[] {
  const candles: Candle[] = [];
  for (const value of values) {
    const candle = {
      datetime: value.datetime,
      open: Number.parseFloat(value.open),
      high: Number.parseFloat(value.high),
      low: Number.parseFloat(value.low),
      close: Number.parseFloat(value.close),
    };
    if (
      value.datetime.length === 0 ||
      !Number.isFinite(candle.open) ||
      !Number.isFinite(candle.high) ||
      !Number.isFinite(candle.low) ||
      !Number.isFinite(candle.close)
    ) {
      continue;
    }
    candles.push(candle);
  }
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

/**
 * Moscow Exchange ISS provider — российские акции (LKOH, GAZP, SBER, etc).
 *
 * Open API без auth: https://iss.moex.com/iss/
 * Бесплатно, без квот. Возвращает official exchange data.
 *
 * Endpoints:
 *   GET /iss/engines/stock/markets/shares/securities/{SECID}/candles.json
 *     ?from=YYYY-MM-DD&till=YYYY-MM-DD&interval={1|10|60|24}
 *
 *   interval: 1=1min, 10=10min, 60=hourly, 24=daily
 *
 * Response format:
 *   { "candles": { "columns": [...], "data": [[open, close, high, low, ...], ...] } }
 */
import { fetchWithRetry } from "../../lib/http";
import { errorKind, log } from "../../lib/log";
import type { Candle } from "../scoring";
import { MOEX_ISS_ORIGIN, type MoexTransport, createMoexTransport } from "./moex-transport";
import type { FetchResult, Interval, PriceProvider, ResolvedSymbol } from "./types";

const BASE_URL = `${MOEX_ISS_ORIGIN}/iss`;
const REQUEST_TIMEOUT_MS = 8000;
const DAY_MS = 86_400_000;
const MOSCOW_OFFSET_MS = 3 * 3_600_000;

export class MoexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoexError";
  }
}

interface MoexCandlesResponse {
  candles?: {
    columns: string[];
    data: unknown[][];
  };
}

interface MoexSecuritySearchResponse {
  securities?: {
    columns: string[];
    data: unknown[][];
  };
}

export class MoexProvider implements PriceProvider {
  constructor(private readonly transport: MoexTransport = createMoexTransport()) {}

  async fetchCandles(symbol: string, interval: Interval, count: number): Promise<FetchResult> {
    const hourly = interval === "1h";
    const daysBack = hourly ? Math.max(Math.ceil(count / 8) + 20, 40) : Math.ceil(count * 7 / 5) + 50;
    // Keep responses small and below the 500-row ISS limit, even with 24 hourly bars per day.
    const windowDays = hourly ? 6 : 60;
    const moscowNow = Date.now() + MOSCOW_OFFSET_MS;
    const url = `${BASE_URL}/engines/stock/markets/shares/securities/${encodeURIComponent(symbol)}/candles.json`;
    const candles: Candle[] = [];
    for (let newest = 0; newest <= daysBack && candles.length < count; newest += windowDays) {
      const oldest = Math.min(newest + windowDays - 1, daysBack);
      const params = new URLSearchParams({
        interval: hourly ? "60" : "24",
        from: new Date(moscowNow - oldest * DAY_MS).toISOString().slice(0, 10),
        till: new Date(moscowNow - newest * DAY_MS).toISOString().slice(0, 10),
        "iss.meta": "off",
        "iss.only": "candles",
        "candles.columns": "open,close,high,low,begin",
      });
      const res = await fetchWithRetry(`${url}?${params}`, {
        fetcher: this.transport.fetch,
      });
      const payload = (await res.json()) as MoexCandlesResponse;
      if (!payload.candles) throw new MoexError("Unexpected MOEX payload");
      const { columns, data } = payload.candles;
      if (data.length > 0) candles.unshift(...parseCandles(columns, data));
    }
    if (candles.length === 0) throw new MoexError("No valid MOEX candles");
    return { candles: candles.slice(-count), creditsUsed: 0 };
  }

  async resolveSymbol(symbol: string): Promise<ResolvedSymbol | null> {
    const upper = symbol.toUpperCase();
    // MOEX securities search.
    const url = `${BASE_URL}/securities.json?q=${encodeURIComponent(upper)}&iss.only=securities&securities.columns=secid,shortname,is_traded,group&engine=stock&market=shares`;
    try {
      const res = await this.transport.fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!res.ok) return null;
      const payload = (await res.json()) as MoexSecuritySearchResponse;
      const cols = payload.securities?.columns ?? [];
      const data = payload.securities?.data ?? [];
      const secidIdx = cols.indexOf("secid");
      const nameIdx = cols.indexOf("shortname");
      const tradedIdx = cols.indexOf("is_traded");
      if (secidIdx === -1 || tradedIdx === -1) return null;
      // Точный match по secid + торгуется сейчас.
      const exact = data.find(
        (row) => String(row[secidIdx]).toUpperCase() === upper && row[tradedIdx] === 1,
      );
      const row = exact ?? data.find((r) => r[tradedIdx] === 1);
      if (!row) return null;
      return {
        symbol: String(row[secidIdx]),
        display_name: String(row[nameIdx] ?? row[secidIdx]),
        type: "stock_ru",
        currency: "RUB",
      };
    } catch (err) {
      log("warn", "moex_resolve_failed", { symbol, error_kind: errorKind(err) });
      return null;
    }
  }
}

export function parseCandles(columns: string[], data: unknown[][]): Candle[] {
  const openIdx = columns.indexOf("open");
  const closeIdx = columns.indexOf("close");
  const highIdx = columns.indexOf("high");
  const lowIdx = columns.indexOf("low");
  const beginIdx = columns.indexOf("begin");
  if (openIdx === -1 || closeIdx === -1 || highIdx === -1 || lowIdx === -1 || beginIdx === -1) {
    throw new MoexError("MOEX candles missing required OHLC/begin columns");
  }
  const candles: Candle[] = [];
  for (const row of data) {
    const rawOpen = row[openIdx];
    const rawClose = row[closeIdx];
    const rawHigh = row[highIdx];
    const rawLow = row[lowIdx];
    if (
      typeof rawOpen !== "number" ||
      typeof rawClose !== "number" ||
      typeof rawHigh !== "number" ||
      typeof rawLow !== "number"
    ) {
      continue;
    }
    const open = rawOpen;
    const close = rawClose;
    const high = rawHigh;
    const low = rawLow;
    const begin = String(row[beginIdx]);
    if (
      !Number.isFinite(open) ||
      !Number.isFinite(close) ||
      !Number.isFinite(high) ||
      !Number.isFinite(low)
    ) {
      continue;
    }
    // MOEX даёт "YYYY-MM-DD HH:MM:SS" (MSK timezone). Convert to ISO UTC.
    // Replace space with T, append +03:00, parse → UTC ISO.
    const timestamp = new Date(`${begin.replace(" ", "T")}+03:00`);
    if (!Number.isFinite(timestamp.getTime())) continue;
    const iso = timestamp.toISOString();
    candles.push({ datetime: iso, open, high, low, close });
  }
  candles.sort((a, b) => a.datetime.localeCompare(b.datetime));
  return candles;
}

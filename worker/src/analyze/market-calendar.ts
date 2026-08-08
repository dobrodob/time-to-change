/**
 * Открытие/закрытие торговых сессий по UTC. Per-asset-type.
 *
 * - forex / commodity: Sunday 22:00 UTC → Friday 22:00 UTC (spot FX week)
 * - stock_us: NYSE/NASDAQ ≈ 14:30-21:00 UTC weekdays (09:30-16:00 ET; DST handled
 *   через USET helper — для MVP approximation без DST OK, alerts могут пропустить
 *   первые/последние 30 мин)
 * - stock_ru: MOEX 07:00-20:50 UTC weekdays (10:00-23:50 MSK, MSK = UTC+3 fixed)
 * - crypto: 24/7
 * - index: следует за stock_us hours
 */
import type { AssetType } from "../state/schema";

/** True если spot FX/forex сейчас торгуется (UTC). */
export function isMarketOpen(nowIso: string): boolean {
  return isForexOpen(nowIso);
}

export function isForexOpen(nowIso: string): boolean {
  const now = new Date(nowIso);
  if (Number.isNaN(now.getTime())) throw new Error(`Invalid ISO: ${nowIso}`);
  const weekday = (now.getUTCDay() + 6) % 7; // 0=Mon, 6=Sun
  const hour = now.getUTCHours();
  const closed = (weekday === 4 && hour >= 22) || weekday === 5 || (weekday === 6 && hour < 22);
  return !closed;
}

/** US stock market: weekdays ~14:30-21:00 UTC (rough, не учитывает DST). */
export function isUsStockMarketOpen(nowIso: string): boolean {
  const now = new Date(nowIso);
  if (Number.isNaN(now.getTime())) throw new Error(`Invalid ISO: ${nowIso}`);
  const weekday = (now.getUTCDay() + 6) % 7;
  if (weekday >= 5) return false; // Sat/Sun closed
  const hour = now.getUTCHours();
  const minute = now.getUTCMinutes();
  // Rough: 14:00-21:00 UTC (включаем небольшую погрешность на DST).
  if (hour < 14) return false;
  if (hour === 14 && minute < 0) return false; // 14:00
  if (hour >= 21) return false;
  return true;
}

/** MOEX (Moscow Exchange): weekdays 07:00-20:50 UTC. */
export function isMoexOpen(nowIso: string): boolean {
  const now = new Date(nowIso);
  if (Number.isNaN(now.getTime())) throw new Error(`Invalid ISO: ${nowIso}`);
  const weekday = (now.getUTCDay() + 6) % 7;
  if (weekday >= 5) return false;
  const hour = now.getUTCHours();
  const minute = now.getUTCMinutes();
  if (hour < 7) return false;
  if (hour > 20) return false;
  if (hour === 20 && minute > 50) return false;
  return true;
}

/** Asset-type-aware market hours. */
export function isMarketOpenForType(type: AssetType, nowIso: string): boolean {
  switch (type) {
    case "forex":
    case "commodity":
      return isForexOpen(nowIso);
    case "stock_us":
    case "index":
      return isUsStockMarketOpen(nowIso);
    case "stock_ru":
      return isMoexOpen(nowIso);
    case "crypto":
      return true; // 24/7
  }
}

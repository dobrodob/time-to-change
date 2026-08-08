/**
 * UTC ↔ Europe/Madrid utilities. DST-correct via Intl.DateTimeFormat (доступен
 * в Workers runtime без флагов).
 *
 * Замена Temporal API из spec — Temporal в Workers ещё не GA (2026-05).
 * Intl стабилен и достаточно функционален для наших случаев: получить hour
 * локального Madrid времени по UTC ISO + проверить quiet window cross-midnight.
 */

const MADRID = "Europe/Madrid";

/**
 * Возвращает hour (0-23) локального Madrid времени для данного UTC моменту.
 * Корректно обрабатывает DST (CEST UTC+2 апрель-октябрь, CET UTC+1 ноябрь-март).
 */
export function madridHourFromUtc(utcIso: string): number {
  const date = new Date(utcIso);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid UTC ISO: ${utcIso}`);
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: MADRID,
    hour: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const hourPart = parts.find((p) => p.type === "hour")?.value ?? "0";
  const hour = Number.parseInt(hourPart, 10);
  // Intl возвращает 24 для полуночи — нормализуем в 0.
  return hour === 24 ? 0 : hour;
}

/**
 * True если данный UTC момент попадает в quiet window [fromHour, toHour)
 * для пользователя (в локальном Madrid времени).
 *
 * - fromHour == toHour → окно нулевой длины → false (выключено).
 * - fromHour < toHour → обычное окно (например 22-23).
 * - fromHour > toHour → cross-midnight (например 23-7: 23,00,01,...06).
 *
 * toHour exclusive: для quiet 23→7 час 7:00 НЕ в quiet, час 6:59 — в quiet.
 */
export function isInQuietWindow(utcIso: string, fromHour: number, toHour: number): boolean {
  if (fromHour === toHour) return false;
  const h = madridHourFromUtc(utcIso);
  if (fromHour < toHour) {
    return h >= fromHour && h < toHour;
  }
  // cross-midnight
  return h >= fromHour || h < toHour;
}

/** Текущий момент в ISO 8601 UTC. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Сравнение двух ISO timestamps: `a` после `b`? */
export function isAfter(a: string, b: string): boolean {
  return new Date(a).getTime() > new Date(b).getTime();
}

/** Разница в миллисекундах между двумя ISO. `a - b`. */
export function diffMs(a: string, b: string): number {
  return new Date(a).getTime() - new Date(b).getTime();
}

/** Добавить миллисекунды к ISO timestamp, вернуть новый ISO. */
export function addMs(iso: string, ms: number): string {
  return new Date(new Date(iso).getTime() + ms).toISOString();
}

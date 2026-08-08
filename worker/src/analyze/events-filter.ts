/**
 * Blackout-окна вокруг ECB/Fed/CPI/NFP.
 * Port of src/events/filter.py.
 *
 * Данные хранятся в D1 table `events` (минимальная схема: ts, type, description).
 * Windows вычисляются по type через DEFAULT_WINDOWS_MIN.
 */
import type { Event as DbEvent } from "../state/schema";

const DEFAULT_WINDOWS_MIN: Record<string, [number, number]> = {
  ECB: [90, 180],
  FOMC: [120, 240],
  NFP: [60, 120],
  CPI: [60, 90],
  OTHER: [30, 60],
};

export interface BlackoutWindow {
  type: string;
  title: string;
  ts: string;
  blackoutStart: string;
  blackoutEnd: string;
}

function getWindow(type: string): [number, number] {
  return DEFAULT_WINDOWS_MIN[type.toUpperCase()] ?? DEFAULT_WINDOWS_MIN.OTHER;
}

export function toBlackoutWindow(event: DbEvent): BlackoutWindow {
  const [beforeMin, afterMin] = getWindow(event.type);
  const ts = new Date(event.ts).getTime();
  return {
    type: event.type,
    title: event.description ?? event.type,
    ts: event.ts,
    blackoutStart: new Date(ts - beforeMin * 60_000).toISOString(),
    blackoutEnd: new Date(ts + afterMin * 60_000).toISOString(),
  };
}

/**
 * Проверяет, попадает ли `whenIso` в blackout окно хотя бы одного из events.
 * Возвращает первое матчащее окно, или null.
 */
export function findBlackout(whenIso: string, events: DbEvent[]): BlackoutWindow | null {
  const when = new Date(whenIso).getTime();
  for (const e of events) {
    const win = toBlackoutWindow(e);
    const start = new Date(win.blackoutStart).getTime();
    const end = new Date(win.blackoutEnd).getTime();
    if (when >= start && when <= end) return win;
  }
  return null;
}

/** Ближайшее событие после `whenIso` (с учётом blackout_start), или null. */
export function nextEventAfter(whenIso: string, events: DbEvent[]): BlackoutWindow | null {
  const when = new Date(whenIso).getTime();
  let best: BlackoutWindow | null = null;
  let bestStart = Number.POSITIVE_INFINITY;
  for (const e of events) {
    const win = toBlackoutWindow(e);
    const start = new Date(win.blackoutStart).getTime();
    if (start >= when && start < bestStart) {
      best = win;
      bestStart = start;
    }
  }
  return best;
}

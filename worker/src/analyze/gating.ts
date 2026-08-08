/**
 * Глобальное решение «слать ли алерт» — events → regime → edge → cooldown.
 * Port of src/alerts/gating.py.
 */
import type { AlertRecord } from "../state/schema";
import { type Candle, type Regime, regimeRank } from "./scoring";

export interface GateDecision {
  allow: boolean;
  reason: string;
}

export interface EventLike {
  type: string;
  title?: string;
  ts: string;
}

export interface GatingContext {
  newRegime: Regime;
  edgePct: number;
  /** Активное blackout-событие, или null. */
  blackoutEvent: EventLike | null;
  /** Последний отправленный алерт (для cooldown). */
  lastAlert: AlertRecord | null;
  /** Текущее время (ISO 8601 UTC). */
  now: string;
  minEdgePct: number;
  cooldownHours: number;
}

/**
 * Решает: слать ли алерт. Порядок first-match:
 *   1. event blackout
 *   2. regime ∈ {cooldown, watch}
 *   3. edge < min_edge_pct
 *   4. cooldown: same/lower regime within cooldown_hours
 *   5. → allow
 */
export function decide(ctx: GatingContext): GateDecision {
  if (ctx.blackoutEvent !== null) {
    const event = ctx.blackoutEvent;
    return {
      allow: false,
      reason: `event blackout: ${event.type} ${event.title ?? ""} at ${event.ts}`.trim(),
    };
  }
  if (ctx.newRegime === "cooldown" || ctx.newRegime === "watch") {
    return { allow: false, reason: `regime '${ctx.newRegime}' below alert threshold` };
  }
  if (ctx.minEdgePct > 0 && ctx.edgePct < ctx.minEdgePct) {
    return {
      allow: false,
      reason: `edge ${ctx.edgePct.toFixed(2)}% < min ${ctx.minEdgePct.toFixed(2)}%`,
    };
  }
  if (ctx.lastAlert !== null) {
    const deltaMs = new Date(ctx.now).getTime() - new Date(ctx.lastAlert.ts).getTime();
    const cooldownMs = ctx.cooldownHours * 3600 * 1000;
    if (deltaMs < cooldownMs) {
      const newRank = regimeRank(ctx.newRegime);
      const oldRank = regimeRank(safeRegime(ctx.lastAlert.regime));
      if (newRank <= oldRank) {
        return {
          allow: false,
          reason: `cooldown: same/lower regime ('${ctx.lastAlert.regime}' → '${ctx.newRegime}') within ${ctx.cooldownHours}h`,
        };
      }
    }
  }
  const sign = ctx.edgePct >= 0 ? "+" : "";
  return {
    allow: true,
    reason: `regime '${ctx.newRegime}', edge ${sign}${ctx.edgePct.toFixed(2)}%`,
  };
}

/**
 * edge = (current - baseline) / baseline * 100. Если baseline нет — 0.
 * Port src/alerts/gating.py:compute_edge_pct.
 */
export function computeEdgePct(currentRate: number, baselineMedian30d: number | null): number {
  if (baselineMedian30d === null || baselineMedian30d === 0) return 0;
  return ((currentRate - baselineMedian30d) / baselineMedian30d) * 100;
}

/**
 * Дневной edge — % изменения относительно предыдущей дневной свечи (вчера).
 * Считается из close-цен: (last.close - prev.close) / prev.close * 100.
 *
 * Возвращает null, если:
 * - меньше 2 daily candles (для новых assets без истории);
 * - prev.close == 0 (защита от деления на ноль).
 *
 * Используется в утреннем digest для строки «Edge за день», чтобы юзер видел
 * вчера→сегодня дельту рядом с месячным edge'ом.
 */
export function computeDailyEdgePct(daily: Candle[]): number | null {
  if (daily.length < 2) return null;
  const prev = daily[daily.length - 2].close;
  const last = daily[daily.length - 1].close;
  if (prev === 0 || Number.isNaN(prev) || Number.isNaN(last)) return null;
  return ((last - prev) / prev) * 100;
}

function safeRegime(value: string | null | undefined): Regime | null {
  if (value === "cooldown" || value === "watch" || value === "partial" || value === "strong") {
    return value;
  }
  return null;
}

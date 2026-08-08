/**
 * Pacing logic для бюджет-режима.
 * Port of src/budget/pacing.py.
 *
 * Чем меньше времени, тем агрессивнее советы; чем больше опережение —
 * тем расслабленнее. Pure-функция, без I/O.
 */
import type { BotState } from "../state/schema";

export type Pressure = "ahead" | "on_track" | "behind" | "critical";

export interface PacingSnapshot {
  days_total: number;
  days_elapsed: number;
  days_left: number;
  progress_pct: number;
  expected_pct: number;
  pacing_ratio: number;
  pressure: Pressure;
  suggested_pct: number;
  daily_target_eur: number;
}

/**
 * Считает текущее положение по графику. null если бюджет не активен.
 */
export function computePacing(state: BotState, nowIso: string): PacingSnapshot | null {
  if (
    state.budget_target_eur === null ||
    state.budget_deadline === null ||
    state.budget_target_eur <= 0
  ) {
    return null;
  }
  const now = new Date(nowIso).getTime();
  const started = state.budget_started_at ? new Date(state.budget_started_at).getTime() : now;
  const deadline = new Date(state.budget_deadline).getTime();

  const daysTotal = Math.max((deadline - started) / 86400_000, 1.0);
  const daysElapsed = Math.max((now - started) / 86400_000, 0);
  const daysLeft = Math.max((deadline - now) / 86400_000, 0);

  const target = state.budget_target_eur;
  const converted = state.budget_converted_eur;
  const progressPct = (converted / target) * 100;
  const expectedPct = Math.min(100, (daysElapsed / daysTotal) * 100);

  const pacingRatio = expectedPct <= 0 ? 1 : progressPct / expectedPct;
  const remainingEur = Math.max(0, target - converted);
  const dailyTargetEur = remainingEur / Math.max(daysLeft, 1.0);

  let pressure: Pressure;
  if (remainingEur <= 0) {
    pressure = "ahead";
  } else if (daysLeft < 3 && remainingEur > 0) {
    pressure = "critical";
  } else if (daysElapsed < 1.0) {
    pressure = "on_track";
  } else if (pacingRatio >= 1.15) {
    pressure = "ahead";
  } else if (pacingRatio >= 0.85) {
    pressure = "on_track";
  } else {
    pressure = "behind";
  }

  const suggestedPct = suggestPct(pressure);

  return {
    days_total: daysTotal,
    days_elapsed: daysElapsed,
    days_left: daysLeft,
    progress_pct: progressPct,
    expected_pct: expectedPct,
    pacing_ratio: pacingRatio,
    pressure,
    suggested_pct: suggestedPct,
    daily_target_eur: dailyTargetEur,
  };
}

function suggestPct(pressure: Pressure): number {
  switch (pressure) {
    case "critical":
      return 80;
    case "behind":
      return 50;
    case "ahead":
      return 20;
    default:
      return 30;
  }
}

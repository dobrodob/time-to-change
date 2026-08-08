"""Глобальное решение «есть ли что слать»: events → regime → edge → cooldown.

Per-user silence НЕ проверяется здесь — это зона рассылки (analyze.py),
которая для каждого user'а смотрит его silence отдельно.

Pure-функция: на вход состояние, calendar, score, config; на выход —
GateDecision (allow/suppress + reason).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from src.analysis.scoring import Regime, regime_rank
from src.events.filter import Event, is_in_blackout
from src.state.store import State


@dataclass(frozen=True)
class GateDecision:
    allow: bool
    reason: str  # человекочитаемое объяснение для логов и /status


def decide(
    *,
    state: State,
    new_regime: Regime,
    edge_pct: float,
    events: list[Event],
    min_edge_pct: float,
    cooldown_hours: int,
    now: datetime | None = None,
) -> GateDecision:
    """Глобальное решение — слать ли сейчас алерт хоть кому-то.

    Порядок проверок (first-match wins для лога reason):
    1. event blackout
    2. regime ∈ {cooldown, watch}
    3. edge < min_edge_pct (если min_edge_pct > 0)
    4. regime равен/ниже последнего за cooldown_hours
    5. → разрешить
    """
    now = now or datetime.now(timezone.utc)

    in_blackout, event = is_in_blackout(now, events)
    if in_blackout and event is not None:
        return GateDecision(False, f"event blackout: {event.type} {event.title} at {event.ts.isoformat()}")

    if new_regime in ("cooldown", "watch"):
        return GateDecision(False, f"regime '{new_regime}' below alert threshold")

    if min_edge_pct > 0 and edge_pct < min_edge_pct:
        return GateDecision(False, f"edge {edge_pct:.2f}% < min {min_edge_pct:.2f}%")

    last = state.last_alert
    if last is not None:
        delta = now - _ensure_utc(last.ts)
        if delta < timedelta(hours=cooldown_hours):
            new_rank = regime_rank(new_regime)
            old_rank = regime_rank(_safe_regime(last.regime))
            if new_rank <= old_rank:
                return GateDecision(
                    False,
                    f"cooldown: same/lower regime ('{last.regime}' → '{new_regime}') "
                    f"within {cooldown_hours}h",
                )
            # else: апгрейд regime — пропускаем

    return GateDecision(True, f"regime '{new_regime}', edge {edge_pct:+.2f}%")


def compute_edge_pct(current_rate: float, baseline_median_30d: float | None) -> float:
    """edge = (current - baseline) / baseline * 100. Если baseline нет — 0."""
    if baseline_median_30d is None or baseline_median_30d == 0:
        return 0.0
    return (current_rate - baseline_median_30d) / baseline_median_30d * 100.0


def _ensure_utc(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _safe_regime(value: str | None) -> Regime | None:
    if value in ("cooldown", "watch", "partial", "strong"):
        return value  # type: ignore[return-value]
    return None

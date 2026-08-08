"""Pacing logic для бюджет-режима.

Основная задача: понять, насколько пользователь укладывается в график «поменять X EUR
за Y дней» и подкручивать агрессивность рекомендаций. Чем меньше времени,
тем агрессивнее советы; чем больше опережение по графику — тем расслабленнее.

Все pure-функции, без I/O. На входе BudgetState + now, на выходе число и
человекочитаемая интерпретация.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Literal

from src.state.store import BudgetState

Pressure = Literal["ahead", "on_track", "behind", "critical"]


@dataclass(frozen=True)
class PacingSnapshot:
    """Слепок прогресса по бюджету для отображения и принятия решений."""
    days_total: float
    days_elapsed: float
    days_left: float
    progress_pct: float          # сколько % уже поменяли (converted/target)
    expected_pct: float           # сколько % должны были по линейному графику
    pacing_ratio: float           # progress / expected. > 1 = опережаем
    pressure: Pressure
    suggested_pct: int            # рекомендуемая доля для следующей конвертации
    daily_target_eur: float       # сколько EUR в день надо менять чтобы успеть


def compute_pacing(
    budget: BudgetState,
    *,
    now: datetime | None = None,
) -> PacingSnapshot | None:
    """Считает текущее положение по графику. None если бюджет не активен."""
    if not budget.active or budget.target_eur is None or budget.deadline is None:
        return None

    now = now or datetime.now(timezone.utc)
    started = budget.started_at or now
    started = _ensure_utc(started)
    deadline = _ensure_utc(budget.deadline)

    days_total = max((deadline - started).total_seconds() / 86400, 1.0)
    days_elapsed = max((now - started).total_seconds() / 86400, 0.0)
    days_left = max((deadline - now).total_seconds() / 86400, 0.0)

    progress_pct = (budget.converted_eur / budget.target_eur) * 100 if budget.target_eur > 0 else 0.0
    expected_pct = min(100.0, (days_elapsed / days_total) * 100)

    pacing_ratio = 1.0 if expected_pct <= 0 else progress_pct / expected_pct

    remaining_eur = max(0.0, budget.target_eur - budget.converted_eur)
    daily_target_eur = remaining_eur / max(days_left, 1.0)

    # Классификация давления.
    # Первые сутки после старта бюджета — всегда "on_track":
    # ноль конвертаций в первый час нормален, не нужно давить "отстаёшь".
    if remaining_eur <= 0.0:
        pressure: Pressure = "ahead"
    elif days_left < 3 and remaining_eur > 0:
        pressure = "critical"
    elif days_elapsed < 1.0:
        pressure = "on_track"
    elif pacing_ratio >= 1.15:
        pressure = "ahead"
    elif pacing_ratio >= 0.85:
        pressure = "on_track"
    else:
        pressure = "behind"

    suggested_pct = _suggest_pct(pressure, days_left, remaining_eur, budget.target_eur)

    return PacingSnapshot(
        days_total=days_total,
        days_elapsed=days_elapsed,
        days_left=days_left,
        progress_pct=progress_pct,
        expected_pct=expected_pct,
        pacing_ratio=pacing_ratio,
        pressure=pressure,
        suggested_pct=suggested_pct,
        daily_target_eur=daily_target_eur,
    )


def _suggest_pct(
    pressure: Pressure,
    days_left: float,
    remaining_eur: float,
    target_eur: float,
) -> int:
    """Сколько % от ОСТАВШЕГОСЯ EUR-баланса советуем менять при partial-сигнале."""
    if pressure == "critical":
        # Меньше 3 дней — почти всё
        return 80
    if pressure == "behind":
        return 50
    if pressure == "ahead":
        return 20
    return 30  # on_track


def _ensure_utc(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)

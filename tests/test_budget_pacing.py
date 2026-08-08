"""Тесты pacing logic."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from src.budget.pacing import compute_pacing
from src.state.store import BudgetState


def _budget(target: float, started_offset_days: float, deadline_offset_days: float, converted: float = 0.0):
    now = datetime(2026, 5, 8, 12, 0, tzinfo=timezone.utc)
    return BudgetState(
        target_eur=target,
        started_at=now - timedelta(days=started_offset_days),
        deadline=now + timedelta(days=deadline_offset_days),
        converted_eur=converted,
        converted_usd=converted * 1.085,  # реалистичный rate
    ), now


def test_compute_pacing_inactive_returns_none():
    assert compute_pacing(BudgetState()) is None


def test_pacing_on_track():
    """Половина срока, половина суммы — on_track, suggested=30%."""
    budget, now = _budget(target=6000, started_offset_days=15, deadline_offset_days=15, converted=3000)
    snap = compute_pacing(budget, now=now)
    assert snap is not None
    assert 0.85 <= snap.pacing_ratio <= 1.15
    assert snap.pressure == "on_track"
    assert snap.suggested_pct == 30


def test_pacing_behind():
    """Половина срока, поменяли только 1500 — behind."""
    budget, now = _budget(target=6000, started_offset_days=15, deadline_offset_days=15, converted=1500)
    snap = compute_pacing(budget, now=now)
    assert snap is not None
    assert snap.pacing_ratio < 0.85
    assert snap.pressure == "behind"
    assert snap.suggested_pct == 50


def test_pacing_critical_under_3_days():
    """Меньше 3 дней до deadline — critical, агрессивно."""
    budget, now = _budget(target=6000, started_offset_days=28, deadline_offset_days=2, converted=4000)
    snap = compute_pacing(budget, now=now)
    assert snap is not None
    assert snap.pressure == "critical"
    assert snap.suggested_pct >= 70


def test_pacing_ahead():
    """Прошло мало времени, поменяли много — ahead."""
    budget, now = _budget(target=6000, started_offset_days=5, deadline_offset_days=25, converted=5000)
    snap = compute_pacing(budget, now=now)
    assert snap is not None
    assert snap.pacing_ratio > 1.15
    assert snap.pressure == "ahead"
    assert snap.suggested_pct == 20


def test_pacing_complete():
    """Поменяли всё — pressure=ahead независимо от времени."""
    budget, now = _budget(target=6000, started_offset_days=10, deadline_offset_days=20, converted=6000)
    snap = compute_pacing(budget, now=now)
    assert snap is not None
    assert snap.pressure == "ahead"


def test_pacing_daily_target():
    """daily_target_eur = remaining / days_left (приблизительно)."""
    budget, now = _budget(target=6000, started_offset_days=15, deadline_offset_days=15, converted=2000)
    snap = compute_pacing(budget, now=now)
    assert snap is not None
    # Осталось 4000 EUR на 15 дней → 266 EUR/день
    assert 250 < snap.daily_target_eur < 290

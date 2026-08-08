"""Тесты глобального решения о посылке алерта.

Per-user silence в gating не проверяется (он per-user в analyze.py).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from src.alerts.gating import compute_edge_pct, decide
from src.events.filter import Event
from src.state.store import AlertRecord, State


def _state_with(*, last_alert: AlertRecord | None = None) -> State:
    s = State()
    if last_alert is not None:
        s.last_alert = last_alert
    return s


def test_event_blackout_blocks():
    now = datetime(2026, 5, 1, 12, 30, tzinfo=timezone.utc)
    event = Event(
        ts=datetime(2026, 5, 1, 12, 30, tzinfo=timezone.utc),
        type="NFP",
        title="US NFP",
        blackout_before_min=60,
        blackout_after_min=120,
    )
    decision = decide(
        state=State(),
        new_regime="strong",
        edge_pct=5.0,
        events=[event],
        min_edge_pct=2.5,
        cooldown_hours=24,
        now=now,
    )
    assert not decision.allow
    assert "blackout" in decision.reason or "NFP" in decision.reason


def test_low_regime_blocks():
    decision = decide(
        state=State(),
        new_regime="watch",
        edge_pct=5.0,
        events=[],
        min_edge_pct=2.5,
        cooldown_hours=24,
        now=datetime.now(timezone.utc),
    )
    assert not decision.allow


def test_edge_below_threshold_blocks():
    decision = decide(
        state=State(),
        new_regime="partial",
        edge_pct=1.5,
        events=[],
        min_edge_pct=2.5,
        cooldown_hours=24,
        now=datetime.now(timezone.utc),
    )
    assert not decision.allow
    assert "edge" in decision.reason


def test_edge_zero_threshold_does_not_block():
    """min_edge_pct=0 → edge не фильтрует, даже отрицательный."""
    decision = decide(
        state=State(),
        new_regime="partial",
        edge_pct=-0.5,
        events=[],
        min_edge_pct=0.0,
        cooldown_hours=24,
        now=datetime.now(timezone.utc),
    )
    assert decision.allow


def test_cooldown_blocks_same_regime():
    now = datetime(2026, 5, 1, 12, 0, tzinfo=timezone.utc)
    last = AlertRecord(ts=now - timedelta(hours=10), regime="partial", score=78, rate=1.09, edge_pct=3.0)
    decision = decide(
        state=_state_with(last_alert=last),
        new_regime="partial",
        edge_pct=3.5,
        events=[],
        min_edge_pct=2.5,
        cooldown_hours=24,
        now=now,
    )
    assert not decision.allow
    assert "cooldown" in decision.reason


def test_upgrade_within_cooldown_passes():
    """partial → strong в течение 24h должен пройти."""
    now = datetime(2026, 5, 1, 12, 0, tzinfo=timezone.utc)
    last = AlertRecord(ts=now - timedelta(hours=2), regime="partial", score=78, rate=1.09, edge_pct=3.0)
    decision = decide(
        state=_state_with(last_alert=last),
        new_regime="strong",
        edge_pct=4.0,
        events=[],
        min_edge_pct=2.5,
        cooldown_hours=24,
        now=now,
    )
    assert decision.allow


def test_first_alert_passes():
    decision = decide(
        state=State(),
        new_regime="partial",
        edge_pct=3.0,
        events=[],
        min_edge_pct=2.5,
        cooldown_hours=24,
        now=datetime.now(timezone.utc),
    )
    assert decision.allow


def test_after_cooldown_same_regime_passes():
    now = datetime(2026, 5, 1, 12, 0, tzinfo=timezone.utc)
    last = AlertRecord(ts=now - timedelta(hours=30), regime="partial", score=78, rate=1.09, edge_pct=3.0)
    decision = decide(
        state=_state_with(last_alert=last),
        new_regime="partial",
        edge_pct=3.5,
        events=[],
        min_edge_pct=2.5,
        cooldown_hours=24,
        now=now,
    )
    assert decision.allow


def test_compute_edge_pct():
    import math
    expected = (1.10 - 1.08) / 1.08 * 100.0
    assert math.isclose(compute_edge_pct(1.10, 1.08), expected, rel_tol=1e-6)
    assert compute_edge_pct(1.05, 1.08) < 0
    assert compute_edge_pct(1.10, None) == 0.0
    assert compute_edge_pct(1.10, 0.0) == 0.0

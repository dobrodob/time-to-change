"""Тесты quiet hours."""

from __future__ import annotations

from datetime import datetime, timezone

from src.state.store import QuietHours, UserSession, is_quiet_for


def _user(enabled: bool, from_h: int, to_h: int) -> UserSession:
    return UserSession(
        chat_id=1,
        role="owner",
        quiet=QuietHours(enabled=enabled, from_hour=from_h, to_hour=to_h),
    )


def test_disabled_user_never_quiet():
    user = _user(False, 23, 7)
    assert not is_quiet_for(user, now=datetime(2026, 5, 8, 2, 0, tzinfo=timezone.utc))


def test_simple_window_8_to_17_madrid():
    """Не-полночное окно (например 9-17 — рабочие часы как quiet)."""
    user = _user(True, 9, 17)
    # 12:00 Madrid (10:00 UTC летом) — внутри
    inside = datetime(2026, 6, 15, 10, 0, tzinfo=timezone.utc)  # лето → CEST = UTC+2 → 12:00 Madrid
    assert is_quiet_for(user, now=inside, tz_name="Europe/Madrid")
    # 18:00 Madrid (16:00 UTC летом) — вне
    outside = datetime(2026, 6, 15, 16, 0, tzinfo=timezone.utc)
    assert not is_quiet_for(user, now=outside, tz_name="Europe/Madrid")


def test_overnight_window_23_to_7_madrid():
    """Окно через полночь."""
    user = _user(True, 23, 7)
    # 02:00 Madrid (00:00 UTC летом)
    inside_night = datetime(2026, 6, 15, 0, 0, tzinfo=timezone.utc)
    assert is_quiet_for(user, now=inside_night, tz_name="Europe/Madrid")
    # 06:00 Madrid (04:00 UTC летом)
    inside_morning = datetime(2026, 6, 15, 4, 0, tzinfo=timezone.utc)
    assert is_quiet_for(user, now=inside_morning, tz_name="Europe/Madrid")
    # 08:00 Madrid (06:00 UTC летом)
    outside_morning = datetime(2026, 6, 15, 6, 0, tzinfo=timezone.utc)
    assert not is_quiet_for(user, now=outside_morning, tz_name="Europe/Madrid")
    # 23:30 Madrid (21:30 UTC летом)
    inside_evening = datetime(2026, 6, 15, 21, 30, tzinfo=timezone.utc)
    assert is_quiet_for(user, now=inside_evening, tz_name="Europe/Madrid")


def test_zero_length_window():
    """from == to → выключено независимо от enabled."""
    user = _user(True, 10, 10)
    assert not is_quiet_for(user, now=datetime(2026, 5, 8, 8, 0, tzinfo=timezone.utc))

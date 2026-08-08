"""Тесты open/close FX-рынка."""

from __future__ import annotations

from datetime import datetime, timezone

from src.data.market_calendar import is_market_open


def test_monday_morning_open():
    # Понедельник 10:00 UTC — рынок открыт
    assert is_market_open(datetime(2026, 5, 4, 10, 0, tzinfo=timezone.utc))


def test_friday_before_close_open():
    # Пятница 21:59 UTC — открыт
    assert is_market_open(datetime(2026, 5, 8, 21, 59, tzinfo=timezone.utc))


def test_friday_22_closed():
    # Пятница 22:00 UTC — закрыт
    assert not is_market_open(datetime(2026, 5, 8, 22, 0, tzinfo=timezone.utc))


def test_saturday_closed():
    # Любая суббота — закрыт
    assert not is_market_open(datetime(2026, 5, 9, 12, 0, tzinfo=timezone.utc))
    assert not is_market_open(datetime(2026, 5, 9, 0, 0, tzinfo=timezone.utc))


def test_sunday_before_22_closed():
    # Воскресенье до 22:00 UTC — закрыт
    assert not is_market_open(datetime(2026, 5, 10, 21, 59, tzinfo=timezone.utc))


def test_sunday_after_22_open():
    # Воскресенье 22:00 UTC — открыт
    assert is_market_open(datetime(2026, 5, 10, 22, 0, tzinfo=timezone.utc))


def test_naive_datetime_treated_as_utc():
    # Без tzinfo — должен трактоваться как UTC
    assert is_market_open(datetime(2026, 5, 4, 10, 0))

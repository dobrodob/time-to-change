"""Тесты парсинга callback_data от inline-кнопок."""

from __future__ import annotations

from datetime import timedelta

from src.telegram_io.commands import parse_callback


def test_done_30():
    cb = parse_callback("b:done:30")
    assert cb.kind == "alert_done_pct"
    assert cb.pct == 30


def test_done_50():
    cb = parse_callback("b:done:50")
    assert cb.kind == "alert_done_pct"
    assert cb.pct == 50


def test_done_invalid_pct():
    assert parse_callback("b:done:0").kind == "unknown"
    assert parse_callback("b:done:101").kind == "unknown"
    assert parse_callback("b:done:abc").kind == "unknown"


def test_silence_1d():
    cb = parse_callback("b:sil:1d")
    assert cb.kind == "alert_silence"
    assert cb.duration == timedelta(days=1)


def test_silence_7d():
    cb = parse_callback("b:sil:7d")
    assert cb.kind == "alert_silence"
    assert cb.duration == timedelta(days=7)


def test_silence_too_long_clamped_to_unknown():
    """Период > 30d — отбрасываем (max silence)."""
    assert parse_callback("b:sil:60d").kind == "unknown"


def test_silence_invalid_format():
    assert parse_callback("b:sil:forever").kind == "unknown"
    assert parse_callback("b:sil:").kind == "unknown"


def test_unknown_prefix():
    assert parse_callback("nope").kind == "unknown"
    assert parse_callback("c:done:30").kind == "unknown"  # not 'b:'
    assert parse_callback("").kind == "unknown"


def test_unknown_action():
    assert parse_callback("b:foo:30").kind == "unknown"

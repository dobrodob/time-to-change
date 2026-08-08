"""Тесты форматтера Telegram-сообщений."""

from __future__ import annotations

from datetime import datetime, timezone

from src.alerts.formatter import (
    TELEGRAM_MENU_COMMANDS,
    format_alert,
    format_help,
    format_invited,
    format_local,
    format_resume,
    format_silence_set,
    format_start,
    format_status,
    format_unknown,
    format_users_list,
    format_whoami,
)
from src.analysis.scoring import ScoreBreakdown
from src.state.store import AlertRecord, SilenceState, State, add_user


def test_format_local_madrid():
    dt = datetime(2026, 6, 1, 12, 0, tzinfo=timezone.utc)
    text = format_local(dt, "Europe/Madrid")
    assert "14:00" in text  # CEST = UTC+2 летом
    assert "Madrid" in text


def test_format_local_naive_treated_utc():
    dt = datetime(2026, 6, 1, 12, 0)
    text = format_local(dt, "Europe/Madrid")
    assert "Madrid" in text


def test_format_alert_contains_essentials():
    bd = ScoreBreakdown(
        score=82.5,
        regime="partial",
        rate=1.0945,
        components={"trend_daily": 100, "timing_hourly": 80, "extremes": 60, "volatility": 90, "historical": 88},
        notes=["курс выше 88% значений за 90 дней", "часовая картина подтверждает"],
    )
    text = format_alert(bd, edge_pct=2.91, now=datetime(2026, 5, 1, 12, 0, tzinfo=timezone.utc))
    assert "1.09450" in text
    assert "82/100" in text  # round(82.5) → "82"
    assert "+2.91" in text
    # regime отображается на русском, не как "partial"
    assert "частичное окно" in text


def test_format_alert_negative_edge_displays_minus():
    bd = ScoreBreakdown(
        score=78.0,
        regime="partial",
        rate=1.075,
        components=dict.fromkeys(["trend_daily", "timing_hourly", "extremes", "volatility", "historical"], 70),
        notes=["технический score"],
    )
    text = format_alert(bd, edge_pct=-0.5, now=datetime.now(timezone.utc))
    assert "-0.50%" in text


def test_format_status_with_per_user_silence():
    state = State()
    add_user(state, 100, role="owner", name="Алекс")
    add_user(state, 200, role="member", name="Друг")
    user = state.telegram.users[0]
    user.silence = SilenceState(
        active=True,
        until=datetime(2026, 5, 8, 12, 0, tzinfo=timezone.utc),
        reason="manual",
    )
    state.last_alert = AlertRecord(
        ts=datetime(2026, 5, 1, 11, 0, tzinfo=timezone.utc),
        regime="partial", score=78.0, rate=1.0942, edge_pct=2.7,
    )

    text = format_status(
        state, now=datetime(2026, 5, 1, 12, 0, tzinfo=timezone.utc), chat_id=100,
    )
    assert "Silence до" in text  # активный silence показан


def test_format_status_other_user_no_silence_not_shown():
    """У не-silenced user'а 'Silence не активен' не должно показываться вообще."""
    state = State()
    add_user(state, 100, role="owner")
    add_user(state, 200, role="member")
    state.telegram.users[0].silence = SilenceState(
        active=True, until=datetime(2030, 1, 1, tzinfo=timezone.utc),
    )
    text = format_status(state, now=datetime.now(timezone.utc), chat_id=200)
    # У user 200 silence не активен → секция silence просто не показывается
    assert "Silence" not in text


def test_format_status_no_users():
    state = State()
    text = format_status(state, now=datetime.now(timezone.utc))
    # Никаких "Подписаны: 0" / "Silence не активен" — лаконично
    assert "Курс EUR/USD" in text
    assert "Подписаны" not in text


def test_format_help_owner_has_invite():
    text = format_help(role="owner")
    assert "/invite" in text
    assert "/users" in text
    assert "Только владельцу" in text


def test_format_help_member_no_invite():
    text = format_help(role="member")
    assert "/invite" not in text
    assert "/users" not in text


def test_format_helpers_have_text():
    assert "EUR/USD" in format_start()
    assert format_unknown()
    assert format_resume()
    assert "Silence" in format_silence_set(datetime(2026, 5, 1, 12, 0, tzinfo=timezone.utc))


def test_format_whoami_includes_chat_id():
    text = format_whoami(123456789)
    assert "123456789" in text
    assert "/invite 123456789" in text


def test_format_invited():
    text = format_invited(789, name="Друг")
    assert "Друг" in text


def test_format_users_list():
    state = State()
    add_user(state, 100, role="owner", name="Алекс")
    add_user(state, 200, role="member", name="Друг")
    text = format_users_list(state)
    assert "Алекс" in text
    assert "Друг" in text
    assert "👑" in text  # owner emoji
    assert "👤" in text  # member emoji


def test_format_users_list_empty():
    assert "Никого" in format_users_list(State())


def test_telegram_menu_commands_format():
    """setMyCommands ожидает [(command, description)]."""
    assert all(isinstance(c, str) and isinstance(d, str) for c, d in TELEGRAM_MENU_COMMANDS)
    # Без слэшей в command
    assert all(not c.startswith("/") for c, _ in TELEGRAM_MENU_COMMANDS)
    # Описания не пустые, но и не слишком длинные (Telegram лимит 256 chars)
    assert all(0 < len(d) < 256 for _, d in TELEGRAM_MENU_COMMANDS)

"""Тесты парсера Telegram-команд."""

from __future__ import annotations

from datetime import timedelta

from src.telegram_io.commands import parse_command


def test_start():
    assert parse_command("/start").kind == "start"


def test_help():
    assert parse_command("/help").kind == "help"


def test_status():
    assert parse_command("/status").kind == "status"


def test_resume():
    assert parse_command("/resume").kind == "resume"


def test_whoami():
    assert parse_command("/whoami").kind == "whoami"


def test_users():
    assert parse_command("/users").kind == "users"


def test_leave():
    assert parse_command("/leave").kind == "leave"


def test_silence_default():
    cmd = parse_command("/silence")
    assert cmd.kind == "silence"
    assert cmd.duration == timedelta(days=7)


def test_silence_with_period():
    assert parse_command("/silence 3d").duration == timedelta(days=3)
    assert parse_command("/silence 1h").duration == timedelta(hours=1)
    assert parse_command("/silence 2w").duration == timedelta(weeks=2)
    assert parse_command("/silence 12h").duration == timedelta(hours=12)


def test_silence_capped_at_max():
    cmd = parse_command("/silence 100d")
    assert cmd.kind == "silence"
    assert cmd.duration == timedelta(days=30)


def test_silence_with_bot_username():
    cmd = parse_command("/silence@my_fx_bot 3d")
    assert cmd.kind == "silence"
    assert cmd.duration == timedelta(days=3)


def test_silence_invalid_arg():
    assert parse_command("/silence forever").kind == "unknown"
    assert parse_command("/silence 0d").kind == "unknown"
    assert parse_command("/silence -1d").kind == "unknown"


def test_invite_with_chat_id():
    cmd = parse_command("/invite 123456789")
    assert cmd.kind == "invite"
    assert cmd.target_chat_id == 123456789


def test_invite_negative_chat_id():
    """Telegram group chat ID может быть отрицательным."""
    cmd = parse_command("/invite -100123456789")
    assert cmd.kind == "invite"
    assert cmd.target_chat_id == -100123456789


def test_invite_no_arg():
    assert parse_command("/invite").kind == "unknown"


def test_invite_non_numeric():
    assert parse_command("/invite @kostya").kind == "unknown"
    assert parse_command("/invite abc123").kind == "unknown"


def test_unknown():
    assert parse_command("hello").kind == "unknown"
    assert parse_command("/foo").kind == "unknown"
    assert parse_command("").kind == "unknown"


def test_case_insensitive():
    assert parse_command("/STATUS").kind == "status"
    assert parse_command("/SiLeNcE 1H").kind == "silence"


# --- /budget ---


def test_budget_set():
    cmd = parse_command("/budget 6000 30d")
    assert cmd.kind == "budget"
    assert cmd.budget_target_eur == 6000.0
    assert cmd.budget_days == 30


def test_budget_without_d_suffix():
    cmd = parse_command("/budget 1500 7")
    assert cmd.kind == "budget"
    assert cmd.budget_target_eur == 1500.0
    assert cmd.budget_days == 7


def test_budget_show():
    assert parse_command("/budget").kind == "budget"
    assert parse_command("/budget show").kind == "budget"


def test_budget_cancel():
    assert parse_command("/budget cancel").kind == "budget_cancel"
    assert parse_command("/budget off").kind == "budget_cancel"


def test_budget_done_with_rate():
    cmd = parse_command("/budget done 1500 1.0852")
    assert cmd.kind == "budget_done"
    assert cmd.budget_done_eur == 1500.0
    assert cmd.budget_done_rate == 1.0852


def test_budget_done_without_rate():
    """Без rate — берётся из последнего breakdown."""
    cmd = parse_command("/budget done 500")
    assert cmd.kind == "budget_done"
    assert cmd.budget_done_eur == 500.0
    assert cmd.budget_done_rate is None


def test_budget_invalid():
    assert parse_command("/budget abc").kind == "unknown"
    assert parse_command("/budget 0 30d").kind == "unknown"
    assert parse_command("/budget 6000 0d").kind == "unknown"
    assert parse_command("/budget 6000 1000d").kind == "unknown"  # > 365


# --- /quiet ---


def test_quiet_set():
    cmd = parse_command("/quiet 23 7")
    assert cmd.kind == "quiet"
    assert cmd.quiet_from == 23
    assert cmd.quiet_to == 7


def test_quiet_off():
    cmd = parse_command("/quiet off")
    assert cmd.kind == "quiet"
    assert cmd.quiet_off


def test_quiet_show():
    assert parse_command("/quiet").kind == "quiet"
    assert parse_command("/quiet show").kind == "quiet"


def test_quiet_invalid_hours():
    assert parse_command("/quiet 25 7").kind == "unknown"
    assert parse_command("/quiet abc def").kind == "unknown"


# --- /digest ---


def test_digest_on():
    cmd = parse_command("/digest on")
    assert cmd.kind == "digest"
    assert cmd.digest_on is True


def test_digest_off():
    cmd = parse_command("/digest off")
    assert cmd.kind == "digest"
    assert cmd.digest_on is False


def test_digest_show():
    cmd = parse_command("/digest")
    assert cmd.kind == "digest"
    assert cmd.digest_on is None


# --- /explain ---


def test_explain():
    assert parse_command("/explain").kind == "explain"

"""Парсер команд Telegram + callback data. Pure-функции."""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import timedelta
from typing import Literal

CommandKind = Literal[
    "start",
    "help",
    "status",
    "silence",
    "resume",
    "whoami",
    "invite",
    "users",
    "leave",
    "budget",
    "budget_done",
    "budget_cancel",
    "quiet",
    "digest",
    "explain",
    "unknown",
]


@dataclass(frozen=True)
class ParsedCommand:
    kind: CommandKind
    duration: timedelta | None = None
    target_chat_id: int | None = None
    # budget: target/days/eur/rate/pct
    budget_target_eur: float | None = None
    budget_days: int | None = None
    budget_done_eur: float | None = None
    budget_done_rate: float | None = None
    # quiet: from/to hours
    quiet_from: int | None = None
    quiet_to: int | None = None
    quiet_off: bool = False
    # digest: on/off
    digest_on: bool | None = None


_PERIOD_RE = re.compile(r"^\s*(\d{1,3})\s*([hdw])\s*$", re.IGNORECASE)
_BUDGET_RE = re.compile(r"^\s*(\d{1,7}(?:\.\d+)?)\s+(\d{1,3})d?\s*$", re.IGNORECASE)
_BUDGET_DONE_RE = re.compile(
    r"^\s*done\s+(\d{1,7}(?:\.\d+)?)(?:\s+(\d+(?:\.\d+)?))?\s*$",
    re.IGNORECASE,
)
_QUIET_RE = re.compile(r"^\s*(\d{1,2})\s+(\d{1,2})\s*$")
_CHAT_ID_RE = re.compile(r"^-?\d{1,15}$")
_DEFAULT_SILENCE = timedelta(days=7)
_MAX_SILENCE = timedelta(days=30)


def parse_command(text: str) -> ParsedCommand:
    text = text.strip()
    if not text.startswith("/"):
        return ParsedCommand(kind="unknown")

    parts = text.split(maxsplit=1)
    cmd = parts[0].lower().split("@", 1)[0]
    arg = parts[1].strip() if len(parts) > 1 else ""

    if cmd == "/start":
        return ParsedCommand(kind="start")
    if cmd == "/help":
        return ParsedCommand(kind="help")
    if cmd == "/status":
        return ParsedCommand(kind="status")
    if cmd == "/resume":
        return ParsedCommand(kind="resume")
    if cmd == "/whoami":
        return ParsedCommand(kind="whoami")
    if cmd == "/users":
        return ParsedCommand(kind="users")
    if cmd == "/leave":
        return ParsedCommand(kind="leave")
    if cmd == "/explain":
        return ParsedCommand(kind="explain")

    if cmd == "/silence":
        if not arg:
            return ParsedCommand(kind="silence", duration=_DEFAULT_SILENCE)
        duration = _parse_period(arg)
        if duration is None:
            return ParsedCommand(kind="unknown")
        if duration > _MAX_SILENCE:
            duration = _MAX_SILENCE
        return ParsedCommand(kind="silence", duration=duration)

    if cmd == "/invite":
        if not arg or not _CHAT_ID_RE.match(arg):
            return ParsedCommand(kind="unknown")
        return ParsedCommand(kind="invite", target_chat_id=int(arg))

    if cmd == "/budget":
        return _parse_budget(arg)

    if cmd == "/quiet":
        return _parse_quiet(arg)

    if cmd == "/digest":
        return _parse_digest(arg)

    return ParsedCommand(kind="unknown")


def _parse_budget(arg: str) -> ParsedCommand:
    if not arg or arg.lower() == "show":
        return ParsedCommand(kind="budget")  # без аргументов = показать
    if arg.lower() in ("cancel", "off", "stop"):
        return ParsedCommand(kind="budget_cancel")

    if arg.lower().startswith("done"):
        match = _BUDGET_DONE_RE.match(arg)
        if not match:
            return ParsedCommand(kind="unknown")
        eur = float(match.group(1))
        rate_str = match.group(2)
        rate = float(rate_str) if rate_str else None
        if eur <= 0:
            return ParsedCommand(kind="unknown")
        return ParsedCommand(
            kind="budget_done",
            budget_done_eur=eur,
            budget_done_rate=rate,
        )

    match = _BUDGET_RE.match(arg)
    if not match:
        return ParsedCommand(kind="unknown")
    target = float(match.group(1))
    days = int(match.group(2))
    if target <= 0 or days <= 0 or days > 365:
        return ParsedCommand(kind="unknown")
    return ParsedCommand(
        kind="budget",
        budget_target_eur=target,
        budget_days=days,
    )


def _parse_quiet(arg: str) -> ParsedCommand:
    if not arg or arg.lower() == "show":
        return ParsedCommand(kind="quiet")  # просто показать
    if arg.lower() in ("off", "disable", "stop"):
        return ParsedCommand(kind="quiet", quiet_off=True)
    match = _QUIET_RE.match(arg)
    if not match:
        return ParsedCommand(kind="unknown")
    f = int(match.group(1))
    t = int(match.group(2))
    if not (0 <= f <= 23) or not (0 <= t <= 23):
        return ParsedCommand(kind="unknown")
    return ParsedCommand(kind="quiet", quiet_from=f, quiet_to=t)


def _parse_digest(arg: str) -> ParsedCommand:
    if arg.lower() in ("", "show"):
        return ParsedCommand(kind="digest")
    if arg.lower() in ("on", "enable"):
        return ParsedCommand(kind="digest", digest_on=True)
    if arg.lower() in ("off", "disable"):
        return ParsedCommand(kind="digest", digest_on=False)
    return ParsedCommand(kind="unknown")


def _parse_period(arg: str) -> timedelta | None:
    match = _PERIOD_RE.match(arg)
    if not match:
        return None
    n = int(match.group(1))
    unit = match.group(2).lower()
    if n <= 0:
        return None
    if unit == "h":
        return timedelta(hours=n)
    if unit == "d":
        return timedelta(days=n)
    if unit == "w":
        return timedelta(weeks=n)
    return None


# --- Callback data (inline buttons) ---

CallbackKind = Literal[
    "alert_done_pct",   # «Поменял N%»
    "alert_silence",    # «Заглушить на T»
    "unknown",
]


@dataclass(frozen=True)
class ParsedCallback:
    kind: CallbackKind
    pct: int | None = None           # для alert_done_pct
    duration: timedelta | None = None  # для alert_silence


def parse_callback(data: str) -> ParsedCallback:
    """Парсит callback_data вида 'b:done:30' или 'b:sil:7d'."""
    parts = data.split(":")
    if len(parts) < 2 or parts[0] != "b":
        return ParsedCallback(kind="unknown")

    if parts[1] == "done" and len(parts) == 3:
        try:
            pct = int(parts[2])
            if not (0 < pct <= 100):
                return ParsedCallback(kind="unknown")
            return ParsedCallback(kind="alert_done_pct", pct=pct)
        except ValueError:
            return ParsedCallback(kind="unknown")

    if parts[1] == "sil" and len(parts) == 3:
        duration = _parse_period(parts[2])
        if duration is None or duration > _MAX_SILENCE:
            return ParsedCallback(kind="unknown")
        return ParsedCallback(kind="alert_silence", duration=duration)

    return ParsedCallback(kind="unknown")

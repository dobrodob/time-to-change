"""Открытие/закрытие FX-рынка по UTC.

Spot FX торгуется с воскресенья 22:00 UTC по пятницу 22:00 UTC. В выходные
рынок закрыт — Twelve Data возвращает «застывший» пятничный close,
индикаторы и алерты на нём бессмысленны (и сжигают квоту).
"""

from __future__ import annotations

from datetime import datetime, timezone


def is_market_open(now: datetime | None = None) -> bool:
    """True если spot FX сейчас торгуется (UTC).

    Закрыт: пятница ≥22:00 UTC, вся суббота, воскресенье <22:00 UTC.
    """
    now = now or datetime.now(timezone.utc)
    now = _ensure_utc(now)
    weekday = now.weekday()  # 0=Mon … 6=Sun
    hour = now.hour

    closed = (
        (weekday == 4 and hour >= 22)
        or weekday == 5
        or (weekday == 6 and hour < 22)
    )
    return not closed


def _ensure_utc(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)

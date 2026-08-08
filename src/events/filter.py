"""Фильтр событий: блэкаут-окна вокруг ECB/Fed/CPI/NFP.

Календарь — JSON-файл `data/events.json`, ведётся вручную (см. README).
В блэкаут-окне алерты подавляются: техника часто становится шумной
вокруг релизов и решений ЦБ.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

log = logging.getLogger(__name__)

# Дефолтные окна (минут до / минут после) по типу события.
DEFAULT_WINDOWS_MIN: dict[str, tuple[int, int]] = {
    "ECB": (90, 180),
    "FOMC": (120, 240),
    "NFP": (60, 120),
    "CPI": (60, 90),
    "OTHER": (30, 60),
}


@dataclass(frozen=True)
class Event:
    ts: datetime
    type: str
    title: str
    blackout_before_min: int
    blackout_after_min: int

    @property
    def blackout_start(self) -> datetime:
        return self.ts - timedelta(minutes=self.blackout_before_min)

    @property
    def blackout_end(self) -> datetime:
        return self.ts + timedelta(minutes=self.blackout_after_min)

    def covers(self, when: datetime) -> bool:
        return self.blackout_start <= when <= self.blackout_end


def load_events(path: Path) -> list[Event]:
    """Читает data/events.json. На пустой/отсутствующий файл — пустой список."""
    if not path.exists():
        log.info("events.json не найден по пути %s — фильтр пуст", path)
        return []

    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        log.error("events.json невалиден: %s — фильтр пуст", exc)
        return []

    items = raw.get("events", []) if isinstance(raw, dict) else []
    events: list[Event] = []
    for item in items:
        try:
            events.append(_parse_event(item))
        except (KeyError, ValueError) as exc:
            log.warning("Пропускаем событие из events.json: %s", exc)
    return events


def is_in_blackout(when: datetime, events: list[Event]) -> tuple[bool, Event | None]:
    """Проверяет, попадает ли `when` в окно блэкаута. Возвращает (флаг, событие)."""
    when = _ensure_utc(when)
    for event in events:
        if event.covers(when):
            return True, event
    return False, None


def next_event_after(when: datetime, events: list[Event]) -> Event | None:
    """Ближайшее событие, начало блэкаута которого >= when."""
    when = _ensure_utc(when)
    upcoming = [e for e in events if e.blackout_start >= when]
    if not upcoming:
        return None
    return min(upcoming, key=lambda e: e.blackout_start)


def _parse_event(item: dict) -> Event:
    ts = datetime.fromisoformat(item["ts"].replace("Z", "+00:00"))
    ts = _ensure_utc(ts)
    type_ = str(item.get("type", "OTHER")).upper()
    title = str(item.get("title", type_))
    default_before, default_after = DEFAULT_WINDOWS_MIN.get(type_, DEFAULT_WINDOWS_MIN["OTHER"])
    before = int(item.get("blackout_before_min", default_before))
    after = int(item.get("blackout_after_min", default_after))
    return Event(
        ts=ts,
        type=type_,
        title=title,
        blackout_before_min=before,
        blackout_after_min=after,
    )


def _ensure_utc(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)

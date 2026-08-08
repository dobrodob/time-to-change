"""Тесты event-blackout фильтра."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from src.events.filter import (
    DEFAULT_WINDOWS_MIN,
    Event,
    is_in_blackout,
    load_events,
    next_event_after,
)


def test_event_covers_window():
    ev = Event(
        ts=datetime(2026, 5, 1, 12, 30, tzinfo=timezone.utc),
        type="NFP",
        title="US NFP",
        blackout_before_min=60,
        blackout_after_min=120,
    )
    # Точно за 60 минут до — попадает
    assert ev.covers(datetime(2026, 5, 1, 11, 30, tzinfo=timezone.utc))
    # Точно через 120 минут после — попадает
    assert ev.covers(datetime(2026, 5, 1, 14, 30, tzinfo=timezone.utc))
    # За 61 минуту до — не попадает
    assert not ev.covers(datetime(2026, 5, 1, 11, 29, tzinfo=timezone.utc))
    # Через 121 минуту после — не попадает
    assert not ev.covers(datetime(2026, 5, 1, 14, 31, tzinfo=timezone.utc))


def test_is_in_blackout_no_events():
    flag, ev = is_in_blackout(datetime.now(timezone.utc), [])
    assert not flag
    assert ev is None


def test_is_in_blackout_finds_event():
    target = datetime(2026, 5, 1, 12, 0, tzinfo=timezone.utc)
    e1 = Event(
        ts=datetime(2026, 5, 1, 12, 0, tzinfo=timezone.utc),
        type="FOMC", title="FOMC",
        blackout_before_min=120, blackout_after_min=240,
    )
    flag, ev = is_in_blackout(target, [e1])
    assert flag
    assert ev is e1


def test_next_event_after_picks_closest():
    now = datetime(2026, 5, 1, 0, 0, tzinfo=timezone.utc)
    e_far = Event(
        ts=now + timedelta(days=10),
        type="FOMC", title="FOMC future",
        blackout_before_min=120, blackout_after_min=240,
    )
    e_near = Event(
        ts=now + timedelta(days=2),
        type="NFP", title="NFP near",
        blackout_before_min=60, blackout_after_min=120,
    )
    chosen = next_event_after(now, [e_far, e_near])
    assert chosen is e_near


def test_load_events_missing_file(tmp_path):
    path = tmp_path / "no_such.json"
    assert load_events(path) == []


def test_load_events_with_defaults(tmp_path):
    path = tmp_path / "events.json"
    payload = {
        "events": [
            {
                "ts": "2026-06-05T12:30:00Z",
                "type": "NFP",
                "title": "US NFP",
                # без явных blackout_before_min/blackout_after_min — берутся дефолты
            }
        ]
    }
    path.write_text(json.dumps(payload))
    events = load_events(path)
    assert len(events) == 1
    e = events[0]
    expected_before, expected_after = DEFAULT_WINDOWS_MIN["NFP"]
    assert e.blackout_before_min == expected_before
    assert e.blackout_after_min == expected_after


def test_load_events_invalid_json(tmp_path):
    path = tmp_path / "events.json"
    path.write_text("{ broken json")
    assert load_events(path) == []

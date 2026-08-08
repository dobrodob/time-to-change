"""Тесты state.store: load/save, миграция v1→v2, multi-user helpers."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from src.state.store import (
    AlertRecord,
    SilenceState,
    State,
    StateLoadError,
    add_user,
    append_alert,
    expire_silences_if_due,
    get_owner,
    get_user,
    is_silenced,
    is_silenced_for,
    load_state,
    remove_user,
    save_state,
)


def test_save_and_load_roundtrip(tmp_path: Path):
    state = State()
    add_user(state, 100, role="owner", name="Кoстя")
    state.last_alert = AlertRecord(
        ts=datetime(2026, 5, 1, 11, 0, tzinfo=timezone.utc),
        regime="partial", score=78.0, rate=1.09, edge_pct=2.7,
    )

    path = tmp_path / "state.json"
    save_state(state, path)

    loaded = load_state(path)
    assert loaded.schema_version == 3
    assert len(loaded.telegram.users) == 1
    owner = get_owner(loaded)
    assert owner is not None
    assert owner.chat_id == 100
    assert owner.role == "owner"
    assert owner.name == "Кoстя"
    assert loaded.last_alert is not None


def test_load_missing_returns_default(tmp_path: Path):
    state = load_state(tmp_path / "no_such.json")
    assert state.schema_version == 3
    assert state.telegram.users == []


def test_load_corrupt_raises_when_no_backup(tmp_path: Path):
    """Битый state.json без .bak — fail loud, не молча дефолт.

    Регрессия от 10 мая 2026: при возврате дефолтного State() три зарегистрированных
    user'а были тихо стёрты, потому что битый файл выглядел как «всё хорошо».
    """
    path = tmp_path / "state.json"
    path.write_text("not a json {{{")
    with pytest.raises(StateLoadError):
        load_state(path)


def test_load_corrupt_falls_back_to_bak(tmp_path: Path):
    """Если основной файл битый, но валидный .bak есть — восстанавливаемся из него."""
    path = tmp_path / "state.json"
    bak_path = tmp_path / "state.json.bak"

    # Валидный backup с user'ом
    good = State()
    add_user(good, 12345, role="owner", name="Алекс")
    save_state(good, bak_path)
    # .bak от save_state создаст ещё свой .bak.bak — не страшно, нас интересует state.json.bak

    # Основной файл — мусор
    path.write_text("not a json {{{")

    loaded = load_state(path)
    assert loaded.schema_version == 3
    owner = get_owner(loaded)
    assert owner is not None
    assert owner.chat_id == 12345


def test_load_corrupt_both_corrupt_raises(tmp_path: Path):
    """Если и основной и .bak битые — fail loud."""
    path = tmp_path / "state.json"
    bak_path = tmp_path / "state.json.bak"
    path.write_text("not a json {{{")
    bak_path.write_text("also garbage }}}")
    with pytest.raises(StateLoadError):
        load_state(path)


def test_save_state_creates_bak(tmp_path: Path):
    """После save_state с существующим валидным файлом — .bak содержит предыдущую версию."""
    path = tmp_path / "state.json"
    bak_path = tmp_path / "state.json.bak"

    # Первая запись
    s1 = State()
    add_user(s1, 111, role="owner", name="first")
    save_state(s1, path)
    assert not bak_path.exists()  # первая запись — .bak ещё нет

    # Вторая запись
    s2 = State()
    add_user(s2, 222, role="owner", name="second")
    save_state(s2, path)

    # .bak должен содержать первую версию (chat_id=111)
    assert bak_path.exists()
    bak_data = json.loads(bak_path.read_text(encoding="utf-8"))
    users = bak_data["telegram"]["users"]
    assert len(users) == 1
    assert users[0]["chat_id"] == 111


def test_save_state_does_not_overwrite_bak_with_invalid_source(tmp_path: Path):
    """Если текущий state.json битый, .bak НЕ переписывается — сохраняем последний валидный."""
    path = tmp_path / "state.json"
    bak_path = tmp_path / "state.json.bak"

    # Создаём валидный .bak вручную (как будто остался с прошлого raze-save)
    valid_state = State()
    add_user(valid_state, 999, role="owner", name="rescue")
    save_state(valid_state, bak_path)

    # Подменяем основной на мусор
    path.write_text("garbage }}}")

    # Сохраняем новое состояние — основной файл битый, .bak не должен меняться
    new_state = State()
    add_user(new_state, 333, role="member")
    save_state(new_state, path)

    # .bak всё ещё содержит rescue (999), не garbage
    bak_data = json.loads(bak_path.read_text(encoding="utf-8"))
    rescue_users = bak_data["telegram"]["users"]
    assert any(u["chat_id"] == 999 for u in rescue_users)


def test_atomic_write_no_tmp_left(tmp_path: Path):
    path = tmp_path / "state.json"
    save_state(State(), path)
    assert path.exists()
    assert not path.with_suffix(".json.tmp").exists()


def test_save_overwrites(tmp_path: Path):
    path = tmp_path / "state.json"
    s1 = State()
    add_user(s1, 123, role="owner")
    save_state(s1, path)

    s2 = State()
    add_user(s2, 999, role="owner")
    save_state(s2, path)

    loaded = load_state(path)
    assert get_user(loaded, 999) is not None
    assert get_user(loaded, 123) is None


def test_append_alert_history_cap():
    state = State()
    base = datetime(2026, 5, 1, 12, 0, tzinfo=timezone.utc)
    for i in range(35):
        alert = AlertRecord(
            ts=base + timedelta(hours=i),
            regime="partial",
            score=80.0,
            rate=1.09 + i * 0.001,
            edge_pct=3.0,
        )
        state = append_alert(state, alert, history_cap=30)
    assert len(state.alert_history_30d) == 30
    assert state.alert_history_30d[0].ts == base + timedelta(hours=5)
    assert state.last_alert.rate > 1.09 + 30 * 0.001


# --- Multi-user ---


def test_add_user_no_dup():
    state = State()
    u1 = add_user(state, 100, role="owner", name="Алекс")
    u2 = add_user(state, 100, role="member", name="Other")  # игнорируется
    assert u1.chat_id == u2.chat_id
    assert len(state.telegram.users) == 1
    assert state.telegram.users[0].role == "owner"  # роль не понизилась


def test_get_owner():
    state = State()
    assert get_owner(state) is None
    add_user(state, 100, role="owner")
    add_user(state, 200, role="member")
    owner = get_owner(state)
    assert owner is not None
    assert owner.chat_id == 100


def test_remove_user():
    state = State()
    add_user(state, 100, role="owner")
    add_user(state, 200, role="member")
    assert remove_user(state, 200)
    assert len(state.telegram.users) == 1
    assert not remove_user(state, 200)  # уже нет


def test_per_user_silence():
    now = datetime(2026, 5, 1, 12, 0, tzinfo=timezone.utc)
    state = State()
    u1 = add_user(state, 100, role="owner")
    u2 = add_user(state, 200, role="member")

    u1.silence = SilenceState(active=True, until=now + timedelta(hours=2))

    assert is_silenced_for(u1, now=now)
    assert not is_silenced_for(u2, now=now)
    assert is_silenced(state, now=now)  # ХОТЯ БЫ один в silence


def test_expire_silences_if_due():
    now = datetime(2026, 5, 1, 12, 0, tzinfo=timezone.utc)
    state = State()
    u1 = add_user(state, 100, role="owner")
    u2 = add_user(state, 200, role="member")
    u1.silence = SilenceState(active=True, until=now - timedelta(seconds=1), reason="manual")
    u2.silence = SilenceState(active=True, until=now + timedelta(hours=1), reason="manual")

    state = expire_silences_if_due(state, now=now)

    assert not u1.silence.active  # истекло, сбросилось
    assert u2.silence.active  # ещё актуально


# --- Migration v1 → v2 ---


def test_migration_v1_to_v2(tmp_path: Path):
    """Старый формат state.json (schema 1, chat_id + global silence) мигрирует."""
    legacy = {
        "schema_version": 1,
        "updated_at": "2026-05-07T21:54:48.128037Z",
        "telegram": {
            "last_update_id": 1002,
            "chat_id": 1001,
        },
        "silence": {
            "active": True,
            "until": "2026-05-14T12:00:00Z",
            "reason": "manual",
        },
        "last_alert": None,
        "alert_history_30d": [],
        "baseline": {"rolling_median_30d": 1.085, "rolling_p90_90d": 1.09, "computed_at": None},
        "quota": {"twelvedata_credits_used_today": 3, "reset_at": "2026-05-08T00:00:00Z"},
        "consecutive_failures": 0,
    }
    path = tmp_path / "state.json"
    path.write_text(json.dumps(legacy))

    state = load_state(path)

    assert state.schema_version == 3
    owner = get_owner(state)
    assert owner is not None
    assert owner.chat_id == 1001
    assert owner.role == "owner"
    assert owner.silence.active
    assert state.telegram.chat_id is None  # legacy очищен
    assert state.silence is None  # legacy очищен

    # save + reload — legacy полей не должно быть в JSON
    save_state(state, path)
    raw = path.read_text()
    assert '"chat_id"' not in raw or '"chat_id": null' not in raw  # либо нет вообще, либо null
    parsed = json.loads(raw)
    assert "silence" not in parsed
    assert "chat_id" not in parsed["telegram"]


def test_pretty_json_human_readable(tmp_path: Path):
    """state.json должен быть pretty (для git diff'ов)."""
    path = tmp_path / "state.json"
    save_state(State(), path)
    text = path.read_text(encoding="utf-8")
    assert "\n" in text
    json.loads(text)


# --- Backward-compat shims ---


def test_is_silenced_no_users():
    """is_silenced на пустом state не падает."""
    assert not is_silenced(State())

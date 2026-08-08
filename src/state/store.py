"""Чтение/запись state.json. Pydantic-схема + атомарная запись.

Schema v3:
- v2: multi-user (users[], per-user silence)
- v3: budget с дедлайном, quiet hours, digest opt-out, last_score_breakdown,
  conversion history.

Pydantic подставляет default'ы для отсутствующих полей при load v2 → v3,
явная миграция нужна только v1 → v2 (chat_id → users[]).
"""

from __future__ import annotations

import json
import logging
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

log = logging.getLogger(__name__)


class StateLoadError(RuntimeError):
    """state.json повреждён и валидного backup нет — fail loud, не молча default."""

UserRole = Literal["owner", "member"]


class SilenceState(BaseModel):
    active: bool = False
    until: datetime | None = None
    reason: str | None = None


class QuietHours(BaseModel):
    """Тихие часы (часы локального времени Madrid). Если from > to — переход через полночь."""
    enabled: bool = False
    from_hour: int = 23  # включительно
    to_hour: int = 7  # исключительно


class UserSession(BaseModel):
    """Один пользователь бота. Все per-user настройки тут."""
    chat_id: int
    role: UserRole = "member"
    name: str | None = None
    joined_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    silence: SilenceState = Field(default_factory=SilenceState)
    quiet: QuietHours = Field(default_factory=QuietHours)
    digest_enabled: bool = True


class TelegramState(BaseModel):
    last_update_id: int = 0
    users: list[UserSession] = Field(default_factory=list)
    menu_set_at: datetime | None = None
    menu_commands_count: int = 0  # для инвалидации при изменении состава меню

    # Legacy (schema v1) — миграция в load_state.
    chat_id: int | None = None


class AlertRecord(BaseModel):
    ts: datetime
    regime: str
    score: float
    rate: float
    edge_pct: float = 0.0


class ConversionRecord(BaseModel):
    """Записанная конвертация (через /budget done или inline-кнопку алерта)."""
    ts: datetime
    eur: float
    rate: float
    pct_at_alert: int | None = None  # 30/50/etc если из inline-кнопки


class BudgetState(BaseModel):
    """Бюджетный режим: 'поменять X EUR за Y дней'."""
    target_eur: float | None = None
    deadline: datetime | None = None
    started_at: datetime | None = None
    converted_eur: float = 0.0
    converted_usd: float = 0.0
    history: list[ConversionRecord] = Field(default_factory=list)

    @property
    def active(self) -> bool:
        return self.target_eur is not None and self.deadline is not None

    @property
    def remaining_eur(self) -> float:
        if self.target_eur is None:
            return 0.0
        return max(0.0, self.target_eur - self.converted_eur)

    @property
    def average_rate(self) -> float | None:
        if self.converted_eur <= 0:
            return None
        return self.converted_usd / self.converted_eur


class LastScoreBreakdown(BaseModel):
    """Последний посчитанный score breakdown — для /explain."""
    ts: datetime
    score: float
    regime: str
    rate: float
    edge_pct: float
    components: dict[str, float | None]
    notes: list[str]
    was_alert: bool = False  # реально ли отправили (или gated)
    gate_reason: str | None = None  # если не отправили, почему


class BaselineState(BaseModel):
    rolling_median_30d: float | None = None
    rolling_p90_90d: float | None = None
    computed_at: datetime | None = None


class QuotaState(BaseModel):
    twelvedata_credits_used_today: int = 0
    reset_at: datetime | None = None


class State(BaseModel):
    schema_version: int = 3
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    telegram: TelegramState = Field(default_factory=TelegramState)
    last_alert: AlertRecord | None = None
    alert_history_30d: list[AlertRecord] = Field(default_factory=list)
    baseline: BaselineState = Field(default_factory=BaselineState)
    quota: QuotaState = Field(default_factory=QuotaState)
    consecutive_failures: int = 0
    budget: BudgetState = Field(default_factory=BudgetState)
    last_score_breakdown: LastScoreBreakdown | None = None
    last_digest_at: datetime | None = None  # для idempotent дайджеста

    # Legacy (schema v1).
    silence: SilenceState | None = None

    def model_dump_json_pretty(self) -> str:
        """Pretty JSON. Drop'аем legacy-поля."""
        data = json.loads(self.model_dump_json())
        data.pop("silence", None)
        if "chat_id" in data.get("telegram", {}):
            data["telegram"].pop("chat_id", None)
        return json.dumps(data, indent=2, ensure_ascii=False)


def load_state(path: Path) -> State:
    """Читает state из файла. Fail-loud при повреждённом файле.

    Порядок:
    1. Если файла нет — возвращаем дефолтный State (legit-кейс: первый запуск).
    2. Парсим основной файл — успех → возвращаем.
    3. Парсинг упал → пробуем backup `state.json.bak` (если есть и валиден).
    4. Backup тоже не помог → **raise StateLoadError**, не возвращаем дефолт.

    Зачем не возвращаем дефолт при ошибке парсинга: ровно это поведение
    стёрло трёх user'ов 10 мая 2026 после того как scarber запушил state.json
    с merge conflict markers. Дефолтный State() выглядит как «всё хорошо»
    и тихо переписывает данные на диске.
    """
    if not path.exists():
        log.info("state.json не существует, создаём дефолт по пути %s", path)
        return State()

    try:
        state = _parse_state_file(path)
        state = _migrate_v1_to_v2(state)
        state.schema_version = 3
        return state
    except (json.JSONDecodeError, ValueError) as primary_exc:
        log.error("state.json невалиден: %s — пробуем backup", primary_exc)
        bak_path = path.with_suffix(path.suffix + ".bak")
        if bak_path.exists():
            try:
                state = _parse_state_file(bak_path)
                state = _migrate_v1_to_v2(state)
                state.schema_version = 3
                log.warning(
                    "Восстановили state из %s (основной файл повреждён)", bak_path,
                )
                return state
            except (json.JSONDecodeError, ValueError) as bak_exc:
                log.error("Backup %s тоже невалиден: %s", bak_path, bak_exc)
        raise StateLoadError(
            f"state.json повреждён и валидного backup нет: {primary_exc}",
        ) from primary_exc


def _parse_state_file(path: Path) -> State:
    raw = path.read_text(encoding="utf-8")
    data = json.loads(raw)
    return State.model_validate(data)


def _migrate_v1_to_v2(state: State) -> State:
    """Конвертирует legacy chat_id + global silence в users[]."""
    legacy_chat_id = state.telegram.chat_id
    legacy_silence = state.silence

    if legacy_chat_id is not None and not state.telegram.users:
        owner = UserSession(
            chat_id=legacy_chat_id,
            role="owner",
            silence=legacy_silence or SilenceState(),
        )
        state.telegram.users = [owner]
        log.info("Миграция v1 → v2: owner chat_id=%d перенесён в users[]", legacy_chat_id)

    state.telegram.chat_id = None
    state.silence = None
    return state


def save_state(state: State, path: Path) -> None:
    """Атомарно пишет state.json + сохраняет backup предыдущей валидной версии.

    Backup пишется в `<path>.bak` ТОЛЬКО если текущий файл валиден как JSON —
    чтобы битый файл не затёр последний хороший backup. При следующем
    load_state, если основной файл окажется битым, мы восстановим из .bak.
    """
    state.updated_at = datetime.now(timezone.utc)
    payload = state.model_dump_json_pretty()

    path.parent.mkdir(parents=True, exist_ok=True)

    if path.exists():
        try:
            json.loads(path.read_text(encoding="utf-8"))
            bak_path = path.with_suffix(path.suffix + ".bak")
            shutil.copy2(path, bak_path)
        except json.JSONDecodeError:
            log.warning(
                "Текущий %s невалиден — НЕ обновляем .bak (сохраняем последний валидный)",
                path,
            )

    tmp_path = path.with_suffix(path.suffix + ".tmp")
    tmp_path.write_text(payload, encoding="utf-8")
    os.replace(tmp_path, path)


def append_alert(state: State, alert: AlertRecord, *, history_cap: int = 30) -> State:
    state.last_alert = alert
    state.alert_history_30d.append(alert)
    if len(state.alert_history_30d) > history_cap:
        state.alert_history_30d = state.alert_history_30d[-history_cap:]
    return state


# --- Multi-user helpers ---


def get_user(state: State, chat_id: int) -> UserSession | None:
    for user in state.telegram.users:
        if user.chat_id == chat_id:
            return user
    return None


def get_owner(state: State) -> UserSession | None:
    for user in state.telegram.users:
        if user.role == "owner":
            return user
    return None


def add_user(
    state: State,
    chat_id: int,
    *,
    role: UserRole = "member",
    name: str | None = None,
) -> UserSession:
    existing = get_user(state, chat_id)
    if existing is not None:
        if name and not existing.name:
            existing.name = name
        return existing
    user = UserSession(chat_id=chat_id, role=role, name=name)
    state.telegram.users.append(user)
    return user


def remove_user(state: State, chat_id: int) -> bool:
    before = len(state.telegram.users)
    state.telegram.users = [u for u in state.telegram.users if u.chat_id != chat_id]
    return len(state.telegram.users) < before


def is_silenced_for(user: UserSession, *, now: datetime | None = None) -> bool:
    now = now or datetime.now(timezone.utc)
    if not user.silence.active:
        return False
    until = user.silence.until
    if until is None:
        return False
    return now < until


def expire_silences_if_due(state: State, *, now: datetime | None = None) -> State:
    now = now or datetime.now(timezone.utc)
    for user in state.telegram.users:
        if user.silence.active and user.silence.until is not None and now >= user.silence.until:
            user.silence.active = False
            user.silence.until = None
            user.silence.reason = None
    return state


def is_quiet_for(
    user: UserSession,
    *,
    now: datetime | None = None,
    tz_name: str = "Europe/Madrid",
) -> bool:
    """True если сейчас в зоне quiet hours для этого user."""
    if not user.quiet.enabled:
        return False
    now = now or datetime.now(timezone.utc)
    from zoneinfo import ZoneInfo
    try:
        local = now.astimezone(ZoneInfo(tz_name))
    except Exception:
        local = now
    h = local.hour
    f = user.quiet.from_hour
    t = user.quiet.to_hour
    if f == t:
        return False  # zero-length window = выключено
    if f < t:
        return f <= h < t
    # переход через полночь, например 23 → 7
    return h >= f or h < t


# --- Budget helpers ---


def record_conversion(
    state: State,
    *,
    eur: float,
    rate: float,
    pct_at_alert: int | None = None,
    now: datetime | None = None,
) -> None:
    now = now or datetime.now(timezone.utc)
    state.budget.history.append(
        ConversionRecord(ts=now, eur=eur, rate=rate, pct_at_alert=pct_at_alert),
    )
    state.budget.converted_eur += eur
    state.budget.converted_usd += eur * rate


# --- Backward-compat shims ---


def is_silenced(state: State, *, now: datetime | None = None) -> bool:
    return any(is_silenced_for(u, now=now) for u in state.telegram.users)


def expire_silence_if_due(state: State, *, now: datetime | None = None) -> State:
    return expire_silences_if_due(state, now=now)

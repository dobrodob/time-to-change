"""Форматирование Telegram-сообщений (HTML parse_mode) + inline-кнопки.

Принципы текстов:
- естественный русский язык, без жаргона
- никаких "🔔 Silence не активен" (показываем только активные состояния)
- никакой лишней мета-информации (квота, кол-во подписанных, etc.) в обычном /status
- regime отображается как "ждать / наблюдать / частичное окно / сильное окно"
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import cast
from zoneinfo import ZoneInfo

from src.analysis.scoring import Regime, ScoreBreakdown
from src.budget.pacing import PacingSnapshot, compute_pacing
from src.state.store import (
    BudgetState,
    LastScoreBreakdown,
    State,
    get_user,
)

# Меню Telegram (для setMyCommands).
TELEGRAM_MENU_COMMANDS: list[tuple[str, str]] = [
    ("status", "Курс и резонность обмена"),
    ("explain", "Из чего складывается оценка"),
    ("budget", "Бюджет: /budget 6000 30d"),
    ("silence", "Заглушить (по умолч 7d)"),
    ("resume", "Включить уведомления"),
    ("quiet", "Тихие часы: /quiet 23 7"),
    ("digest", "Утренний дайджест"),
    ("whoami", "Мой chat_id"),
    ("invite", "Owner: /invite <chat_id>"),
    ("users", "Owner: список подписанных"),
    ("leave", "Удалить себя"),
    ("help", "Список команд"),
]

REGIME_LABEL: dict[Regime, str] = {
    "cooldown": "ждать",
    "watch": "наблюдать",
    "partial": "частичное окно",
    "strong": "сильное окно",
}

REGIME_EMOJI: dict[Regime, str] = {
    "cooldown": "⏸",
    "watch": "👀",
    "partial": "💱",
    "strong": "🚀",
}

REGIME_DEFAULT_PCT: dict[Regime, int] = {
    "cooldown": 0,
    "watch": 0,
    "partial": 30,
    "strong": 50,
}

PRESSURE_RU: dict[str, str] = {
    "ahead": "опережаешь график",
    "on_track": "идёшь по графику",
    "behind": "отстаёшь от графика",
    "critical": "⚠ мало времени",
}


def format_local(dt: datetime, tz_name: str = "Europe/Madrid") -> str:
    """`HH:MM Madrid` — короткий формат для inline-показа."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    try:
        local = dt.astimezone(ZoneInfo(tz_name))
    except Exception:
        local = dt.astimezone(timezone.utc)
        tz_name = "UTC"
    short_tz = tz_name.split("/")[-1]
    return local.strftime(f"%H:%M {short_tz}")


def format_local_full(dt: datetime, tz_name: str = "Europe/Madrid") -> str:
    """`YYYY-MM-DD HH:MM Madrid` — полная дата для логов и истории."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    try:
        local = dt.astimezone(ZoneInfo(tz_name))
    except Exception:
        local = dt.astimezone(timezone.utc)
        tz_name = "UTC"
    short_tz = tz_name.split("/")[-1]
    return local.strftime(f"%Y-%m-%d %H:%M {short_tz}")


def format_date(dt: datetime, tz_name: str = "Europe/Madrid") -> str:
    """`8 июня` — для дат без времени."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    try:
        local = dt.astimezone(ZoneInfo(tz_name))
    except Exception:
        local = dt.astimezone(timezone.utc)
    months_ru = {
        1: "января", 2: "февраля", 3: "марта", 4: "апреля",
        5: "мая", 6: "июня", 7: "июля", 8: "августа",
        9: "сентября", 10: "октября", 11: "ноября", 12: "декабря",
    }
    return f"{local.day} {months_ru[local.month]}"


# --- /status ---


def format_status(
    state: State,
    *,
    now: datetime,
    tz_name: str = "Europe/Madrid",
    chat_id: int | None = None,
) -> str:
    """Лаконичный /status: курс, медианы, edge, резонность, активные настройки."""
    last = state.last_score_breakdown
    lines = ["<b>Курс EUR/USD</b>", ""]

    if last is not None:
        when = format_local(last.ts, tz_name)
        lines.append(f"Курс: <b>{last.rate:.5f}</b> (на {when})")
    else:
        lines.append("Свежие данные ещё не загружены.")

    if state.baseline.rolling_median_30d is not None:
        lines.append(f"Медиана 30d: {state.baseline.rolling_median_30d:.5f}")
    if state.baseline.rolling_p90_90d is not None:
        lines.append(f"Верх 90d: {state.baseline.rolling_p90_90d:.5f}")

    if last is not None:
        lines.append(f"Edge: <b>{last.edge_pct:+.2f}%</b>")
        regime_ru = REGIME_LABEL.get(cast(Regime, last.regime), last.regime)
        lines.append("")
        lines.append(f"Резонность обмена: <b>{last.score:.0f}/100</b> — {regime_ru}")

    # Silence показываем только если активен (это влияет на push'и).
    # Бюджет, quiet, digest — отдельные команды (/budget, /quiet, /digest),
    # в /status не дублируем чтобы не шуметь.
    user = get_user(state, chat_id) if chat_id is not None else None
    if user is not None and user.silence.active and user.silence.until is not None:
        lines.append("")
        lines.append(f"🔇 Silence до {format_local(user.silence.until, tz_name)}")

    return "\n".join(lines)


# --- Alert ---


def format_alert(
    breakdown: ScoreBreakdown,
    edge_pct: float,
    *,
    now: datetime,
    tz_name: str = "Europe/Madrid",
    budget: BudgetState | None = None,
) -> str:
    """Сообщение об алерте — короткое, без меты."""
    regime: Regime = breakdown.regime
    emoji = REGIME_EMOJI.get(regime, "💱")
    when = format_local(now, tz_name)
    notes_lines = "\n".join(f"• {n}" for n in breakdown.notes)

    parts = [
        f"{emoji} <b>EUR/USD — окно для обмена</b>",
        "",
        f"Курс: <b>{breakdown.rate:.5f}</b> (на {when})",
        f"Резонность: <b>{breakdown.score:.0f}/100</b> ({REGIME_LABEL[regime]})",
        f"Edge над 30d: <b>{edge_pct:+.2f}%</b>",
        "",
        notes_lines,
        "",
    ]

    pacing = compute_pacing(budget, now=now) if budget else None
    if pacing is not None and budget is not None and budget.target_eur is not None:
        rec_pct = pacing.suggested_pct
        rec_eur = budget.remaining_eur * rec_pct / 100
        rec_usd = rec_eur * breakdown.rate
        parts.append(_render_budget_block(budget, pacing, tz_name=tz_name))
        parts.append("")
        parts.append(f"Рекомендация: <b>{rec_pct}%</b> остатка ≈ {rec_eur:.0f} EUR ≈ {rec_usd:.0f} USD")
    else:
        rec_pct = REGIME_DEFAULT_PCT.get(regime, 30)
        if rec_pct > 0:
            parts.append(f"Рекомендация: поменять около <b>{rec_pct}%</b> свободных EUR")

    return "\n".join(parts)


def alert_inline_keyboard(
    *,
    breakdown: ScoreBreakdown,
    budget: BudgetState | None = None,
    now: datetime | None = None,
) -> list[list[dict[str, str]]]:
    now = now or datetime.now(timezone.utc)
    pacing = compute_pacing(budget, now=now) if budget else None

    if pacing is not None and budget is not None and budget.target_eur is not None:
        primary_pct = pacing.suggested_pct
        secondary_pct = max(20, min(80, primary_pct - 20))
    else:
        primary_pct = REGIME_DEFAULT_PCT.get(breakdown.regime, 30)
        secondary_pct = max(20, primary_pct - 20)

    eur_remaining = budget.remaining_eur if budget else None

    def btn_label(pct: int) -> str:
        if eur_remaining is not None and eur_remaining > 0:
            return f"Поменял {pct}% (~{eur_remaining * pct / 100:.0f} EUR)"
        return f"Поменял {pct}%"

    return [
        [
            {"text": btn_label(primary_pct), "callback_data": f"b:done:{primary_pct}"},
            {"text": btn_label(secondary_pct), "callback_data": f"b:done:{secondary_pct}"},
        ],
        [
            {"text": "Заглушить 1d", "callback_data": "b:sil:1d"},
            {"text": "Заглушить 7d", "callback_data": "b:sil:7d"},
        ],
    ]


# --- Budget block (общий для /status, /alert, /digest) ---


def _render_budget_block(budget: BudgetState, pacing: PacingSnapshot, *, tz_name: str) -> str:
    pressure_label = PRESSURE_RU.get(pacing.pressure, pacing.pressure)
    target = budget.target_eur or 0.0
    deadline_str = format_date(budget.deadline, tz_name) if budget.deadline else "?"
    days_left = max(1, round(pacing.days_left))
    days_word = _plural_days(days_left)
    daily = pacing.daily_target_eur

    parts = [
        f"💼 <b>Бюджет:</b> {budget.converted_eur:.0f} / {target:.0f} EUR",
        f"   осталось <b>{budget.remaining_eur:.0f} EUR</b> · {days_left} {days_word} до {deadline_str}",
        f"   {pressure_label} · цель {daily:.0f} EUR/день",
    ]
    avg_rate = budget.average_rate
    if avg_rate is not None:
        parts[-1] += f" · средний rate {avg_rate:.5f}"
    return "\n".join(parts)


def _plural_days(n: int) -> str:
    if 11 <= n % 100 <= 14:
        return "дней"
    last = n % 10
    if last == 1:
        return "день"
    if 2 <= last <= 4:
        return "дня"
    return "дней"


# --- /explain ---


def format_explain(
    last: LastScoreBreakdown | None,
    *,
    tz_name: str = "Europe/Madrid",
) -> str:
    if last is None:
        return "Анализ ещё не запускался — попробуй через час."

    weight_map = [
        ("trend_daily", "Дневной тренд", 0.25),
        ("timing_hourly", "Часовой тайминг", 0.25),
        ("extremes", "Экстремумы", 0.20),
        ("volatility", "Волатильность", 0.10),
        ("historical", "Историка (90d)", 0.20),
    ]
    when = format_local(last.ts, tz_name)
    regime_ru = REGIME_LABEL.get(cast(Regime, last.regime), last.regime)

    lines = [
        f"<b>Из чего сейчас оценка</b> — {when}",
        "",
        f"Курс: <b>{last.rate:.5f}</b> · Edge: <b>{last.edge_pct:+.2f}%</b>",
        "",
    ]
    total = 0.0
    for key, label, weight in weight_map:
        value = last.components.get(key)
        if value is None:
            lines.append(f"• {label}: нет данных")
            continue
        contribution = value * weight
        total += contribution
        lines.append(
            f"• {label}: <b>{value:.0f}/100</b> × {weight:.2f} = <b>{contribution:.1f}</b>"
        )
    lines.append("")
    lines.append(f"Итого: <b>{total:.0f}/100</b> — {regime_ru}")

    if last.notes:
        lines.append("")
        lines.append("<b>Что повлияло:</b>")
        for n in last.notes:
            lines.append(f"• {n}")

    if not last.was_alert and last.gate_reason:
        lines.append("")
        lines.append(f"<i>Алерт не отправлен: {last.gate_reason}</i>")

    return "\n".join(lines)


# --- Daily digest ---


def format_digest(
    state: State,
    breakdown: ScoreBreakdown | None,
    edge_pct: float | None,
    *,
    now: datetime,
    tz_name: str = "Europe/Madrid",
) -> str:
    when = format_local(now, tz_name)
    lines = [f"☕ <b>Утро, {when}</b>", ""]

    if breakdown is not None:
        regime_ru = REGIME_LABEL.get(breakdown.regime, breakdown.regime)
        lines.append(f"Курс: <b>{breakdown.rate:.5f}</b>")
        if edge_pct is not None:
            lines.append(f"Edge над 30d: <b>{edge_pct:+.2f}%</b>")
        lines.append(f"Резонность: <b>{breakdown.score:.0f}/100</b> — {regime_ru}")
    else:
        lines.append("Свежих данных нет (рынок закрыт).")

    if state.budget.active:
        pacing = compute_pacing(state.budget, now=now)
        if pacing is not None:
            lines.append("")
            lines.append(_render_budget_block(state.budget, pacing, tz_name=tz_name))

    return "\n".join(lines)


# --- Help / system messages ---


def format_help(*, role: str = "owner") -> str:
    base = (
        "<b>Команды</b>\n"
        "\n"
        "/status — курс и резонность обмена\n"
        "/explain — детальная разбивка оценки\n"
        "\n"
        "/budget 6000 30d — поставить цель\n"
        "/budget done 1500 1.0852 — записать обмен\n"
        "/budget — показать прогресс\n"
        "/budget cancel — снять\n"
        "\n"
        "/silence [период] — заглушить (1h, 3d, 2w; по умолч 7d)\n"
        "/resume — снять silence\n"
        "/quiet 23 7 — тихие часы\n"
        "/quiet off — отключить\n"
        "/digest on|off — утренний дайджест\n"
        "\n"
        "/whoami — мой chat_id\n"
        "/leave — удалить себя\n"
    )
    owner_extras = (
        "\n"
        "<b>Только владельцу:</b>\n"
        "/invite &lt;chat_id&gt; — добавить пользователя\n"
        "/users — кто подписан\n"
    )
    return base + owner_extras if role == "owner" else base


def format_silence_set(until: datetime, *, tz_name: str = "Europe/Madrid") -> str:
    return f"🔇 Silence до {format_local_full(until, tz_name)}"


def format_resume(*, tz_name: str = "Europe/Madrid") -> str:
    return "🔔 Уведомления включены"


def format_unknown() -> str:
    return "Неизвестная команда. /help — список."


def format_start(*, role: str = "owner") -> str:
    return (
        "Привет 👋\n"
        "Слежу за EUR/USD, пишу когда курс выгоден для обмена EUR → USD.\n"
        "\n"
        "/help — все команды."
    )


def format_whoami(chat_id: int) -> str:
    return (
        f"Твой chat_id: <code>{chat_id}</code>\n"
        f"Чтобы получать алерты, попроси владельца:\n"
        f"<code>/invite {chat_id}</code>"
    )


def format_invited(chat_id: int, *, name: str | None = None) -> str:
    return f"✅ Добавлен: {name or f'chat_id {chat_id}'}"


def format_invite_already_member(chat_id: int) -> str:
    return f"chat_id {chat_id} уже подписан"


def format_invite_notify(owner_name: str | None = None) -> str:
    by = f" от {owner_name}" if owner_name else ""
    return (
        f"✅ Тебя добавили в EUR/USD bot{by}.\n"
        f"Алерты будут приходить автоматически.\n"
        f"\n"
        f"/help — список команд."
    )


def format_users_list(state: State, *, tz_name: str = "Europe/Madrid") -> str:
    if not state.telegram.users:
        return "Никого не подписано."
    lines = ["<b>Подписаны:</b>", ""]
    for u in state.telegram.users:
        marker = "👑" if u.role == "owner" else "👤"
        name = u.name or f"chat_id {u.chat_id}"
        flags = ""
        if u.silence.active:
            flags += " 🔇"
        if u.quiet.enabled:
            flags += " 🌙"
        lines.append(f"{marker} {name}{flags}")
    return "\n".join(lines)


def format_left() -> str:
    return "Удалил тебя из бота."


def format_owner_only() -> str:
    return "Эта команда только для владельца."


def format_invite_self() -> str:
    return "Себя приглашать не нужно :)"


# --- Budget messages ---


def format_budget_set(state: State, *, tz_name: str = "Europe/Madrid") -> str:
    target = state.budget.target_eur or 0.0
    deadline_str = format_date(state.budget.deadline, tz_name) if state.budget.deadline else "?"
    pacing = compute_pacing(state.budget)
    daily = pacing.daily_target_eur if pacing else 0.0
    return (
        f"💼 Бюджет: <b>{target:.0f} EUR</b> до {deadline_str}\n"
        f"В среднем нужно ≈ <b>{daily:.0f} EUR/день</b>\n"
        f"\n"
        f"После обмена нажимай кнопки в алертах или /budget done 1500 1.0852"
    )


def format_budget_show(state: State, *, now: datetime, tz_name: str = "Europe/Madrid") -> str:
    if not state.budget.active:
        return "Бюджет не установлен. /budget 6000 30d — поставить."
    pacing = compute_pacing(state.budget, now=now)
    if pacing is None:
        return "Бюджет повреждён. /budget cancel и заново."
    lines = [_render_budget_block(state.budget, pacing, tz_name=tz_name)]
    if state.budget.history:
        lines.append("")
        lines.append("<b>История:</b>")
        for h in state.budget.history[-10:]:
            ts = format_local(h.ts, tz_name)
            lines.append(f"• {ts}: {h.eur:.0f} EUR @ {h.rate:.5f} = {h.eur * h.rate:.0f} USD")
    return "\n".join(lines)


def format_budget_done(state: State, *, eur: float, rate: float) -> str:
    lines = [f"✅ {eur:.0f} EUR @ {rate:.5f} = {eur * rate:.0f} USD"]
    if state.budget.target_eur is not None and state.budget.remaining_eur <= 0:
        lines.append("🎉 Бюджет закрыт целиком!")
    elif state.budget.target_eur is not None:
        lines.append(f"Осталось: <b>{state.budget.remaining_eur:.0f} EUR</b>")
    avg = state.budget.average_rate
    if avg is not None:
        lines.append(f"Средний rate: {avg:.5f}")
    return "\n".join(lines)


def format_budget_cancel() -> str:
    return "💼 Бюджет снят"


def format_budget_no_active() -> str:
    return "Бюджет не установлен. /budget 6000 30d сначала."


def format_quiet_set(from_h: int, to_h: int, *, tz_name: str = "Europe/Madrid") -> str:
    short_tz = tz_name.split("/")[-1]
    return f"🌙 Тихие часы: {from_h:02d}:00 – {to_h:02d}:00 {short_tz}"


def format_quiet_off() -> str:
    return "🔔 Тихие часы отключены"


def format_quiet_show(state: State, chat_id: int, *, tz_name: str = "Europe/Madrid") -> str:
    user = get_user(state, chat_id)
    if user is None or not user.quiet.enabled:
        return "Тихие часы не настроены. /quiet 23 7 — включить."
    short_tz = tz_name.split("/")[-1]
    return f"🌙 Тихие часы: {user.quiet.from_hour:02d}:00 – {user.quiet.to_hour:02d}:00 {short_tz}"


def format_digest_show(state: State, chat_id: int) -> str:
    user = get_user(state, chat_id)
    if user is None:
        return "Не подписан на бот."
    state_ru = "включён" if user.digest_enabled else "выключен"
    return f"📰 Утренний дайджест {state_ru}"


def format_digest_set(enabled: bool, *, hour: int = 11, minute: int = 42, tz_name: str = "Europe/Madrid") -> str:
    if enabled:
        short_tz = tz_name.split("/")[-1]
        return f"📰 Утренний дайджест включён (~{hour:02d}:{minute:02d} {short_tz})"
    return "📰 Утренний дайджест выключен"


# --- Callback responses ---


def format_callback_done(eur: float, rate: float, pct: int) -> str:
    return f"✅ {pct}% = {eur:.0f} EUR @ {rate:.5f} = {eur * rate:.0f} USD"


def format_callback_done_no_budget(pct: int) -> str:
    return f"Записал ~{pct}%. Чтобы вести точный учёт: /budget 6000 30d"


def format_callback_silenced(period_label: str) -> str:
    return f"🔇 Silence на {period_label}"

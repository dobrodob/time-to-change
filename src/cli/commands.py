"""5-минутный обработчик команд: getUpdates → mutate state → reply.

Обрабатывает text-команды и callback_query (inline-кнопки в алертах).
"""

from __future__ import annotations

import logging
import sys
from datetime import datetime, timedelta, timezone

from src.alerts import formatter
from src.config import get_settings
from src.events.filter import load_events, next_event_after
from src.state import git_sync
from src.state.store import (
    BudgetState,
    State,
    UserSession,
    add_user,
    expire_silences_if_due,
    get_owner,
    get_user,
    is_silenced_for,
    load_state,
    record_conversion,
    remove_user,
    save_state,
)
from src.telegram_io.client import (
    TelegramAuthError,
    TelegramBlockedError,
    Update,
    answer_callback_query,
    edit_message_reply_markup,
    get_updates,
    send_message,
    set_my_commands,
)
from src.telegram_io.commands import ParsedCallback, parse_callback, parse_command

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s | %(message)s")
log = logging.getLogger("commands")

_DEFAULT_SILENCE = timedelta(days=7)
_MENU_REFRESH_DAYS = 7


def main() -> int:
    settings = get_settings()
    if not settings.telegram_bot_token:
        log.error("TELEGRAM_BOT_TOKEN не задан — выходим")
        return 1

    state = load_state(settings.state_path)
    state = expire_silences_if_due(state, now=datetime.now(timezone.utc))
    state = _ensure_menu_set(state, settings)

    try:
        updates = get_updates(
            bot_token=settings.telegram_bot_token,
            offset=state.telegram.last_update_id + 1,
            timeout_long_poll=0,
        )
    except TelegramAuthError as exc:
        log.error("Telegram 401: %s", exc)
        return 1
    except Exception as exc:
        log.exception("getUpdates failed: %s", exc)
        return 0

    if not updates:
        log.info("Нет новых updates")
        save_state(state, settings.state_path)
        _push_state(settings.repo_root, "chore(state): no-op tick")
        return 0

    log.info("Получено %d updates", len(updates))
    for upd in updates:
        _handle_update(upd, settings, state)

    save_state(state, settings.state_path)
    _push_state(settings.repo_root, f"chore(state): processed {len(updates)} updates")
    return 0


def _ensure_menu_set(state: State, settings) -> State:
    """Регистрирует Telegram-меню если устарело или изменился состав команд."""
    now = datetime.now(timezone.utc)
    last = state.telegram.menu_set_at
    expected_count = len(formatter.TELEGRAM_MENU_COMMANDS)
    fresh = last is not None and (now - last) < timedelta(days=_MENU_REFRESH_DAYS)
    same_set = state.telegram.menu_commands_count == expected_count
    if fresh and same_set:
        return state
    try:
        set_my_commands(
            bot_token=settings.telegram_bot_token,
            commands=formatter.TELEGRAM_MENU_COMMANDS,
        )
        state.telegram.menu_set_at = now
        state.telegram.menu_commands_count = expected_count
        log.info("Telegram-меню обновлено (%d команд)", expected_count)
    except Exception as exc:
        log.warning("setMyCommands failed: %s", exc)
    return state


def _handle_update(upd: Update, settings, state: State) -> None:
    state.telegram.last_update_id = max(state.telegram.last_update_id, upd.update_id)

    if upd.update_kind == "callback":
        _handle_callback(upd, settings, state)
        return

    cmd = parse_command(upd.text)
    log.info(
        "update_id=%d chat=%d kind=%s sender=%r text=%r",
        upd.update_id, upd.chat_id, cmd.kind, upd.sender_name, upd.text,
    )

    user = get_user(state, upd.chat_id)
    owner = get_owner(state)

    # Owner capture при первом /start
    if owner is None and cmd.kind == "start":
        owner = add_user(state, upd.chat_id, role="owner", name=upd.sender_name)
        log.info("Захвачен owner: chat_id=%d name=%s", upd.chat_id, upd.sender_name)
        _safe_send(settings, upd.chat_id, formatter.format_start(role="owner"))
        _safe_send(settings, upd.chat_id, formatter.format_help(role="owner"))
        return

    # Незарегистрированный — только /start и /whoami получают ответ
    if user is None:
        if cmd.kind in ("start", "whoami"):
            _safe_send(settings, upd.chat_id, formatter.format_whoami(upd.chat_id))
            return
        log.warning("Игнорируем команду от не-зарегистрированного chat_id=%d", upd.chat_id)
        return

    now = datetime.now(timezone.utc)

    if cmd.kind == "start":
        _safe_send(settings, upd.chat_id, formatter.format_start(role=user.role))
        _safe_send(settings, upd.chat_id, formatter.format_help(role=user.role))
    elif cmd.kind == "help":
        _safe_send(settings, upd.chat_id, formatter.format_help(role=user.role))
    elif cmd.kind == "status":
        _send_status(settings, upd.chat_id, user.chat_id, state, now)
    elif cmd.kind == "explain":
        _safe_send(
            settings, upd.chat_id,
            formatter.format_explain(state.last_score_breakdown, tz_name=settings.display_timezone),
        )
    elif cmd.kind == "silence":
        until = now + (cmd.duration or _DEFAULT_SILENCE)
        user.silence.active = True
        user.silence.until = until
        user.silence.reason = "manual"
        _safe_send(
            settings, upd.chat_id,
            formatter.format_silence_set(until, tz_name=settings.display_timezone),
        )
    elif cmd.kind == "resume":
        user.silence.active = False
        user.silence.until = None
        user.silence.reason = None
        _safe_send(settings, upd.chat_id, formatter.format_resume(tz_name=settings.display_timezone))
    elif cmd.kind == "whoami":
        _safe_send(settings, upd.chat_id, formatter.format_whoami(upd.chat_id))
    elif cmd.kind == "invite":
        _handle_invite(cmd, user, state, settings)
    elif cmd.kind == "users":
        if user.role != "owner":
            _safe_send(settings, upd.chat_id, formatter.format_owner_only())
            return
        _safe_send(settings, upd.chat_id, formatter.format_users_list(state, tz_name=settings.display_timezone))
    elif cmd.kind == "leave":
        if user.role == "owner":
            _safe_send(settings, upd.chat_id, "Owner не может покинуть бот через /leave.")
            return
        remove_user(state, user.chat_id)
        _safe_send(settings, upd.chat_id, formatter.format_left())
    elif cmd.kind == "budget":
        _handle_budget(cmd, user, state, settings, now)
    elif cmd.kind == "budget_done":
        _handle_budget_done(cmd, user, state, settings)
    elif cmd.kind == "budget_cancel":
        state.budget = BudgetState()
        _safe_send(settings, upd.chat_id, formatter.format_budget_cancel())
    elif cmd.kind == "quiet":
        _handle_quiet(cmd, user, state, settings)
    elif cmd.kind == "digest":
        _handle_digest(cmd, user, state, settings)
    else:
        if is_silenced_for(user, now=now):
            return
        _safe_send(settings, upd.chat_id, formatter.format_unknown())


def _send_status(settings, chat_id_to: int, viewer_chat_id: int, state: State, now: datetime) -> None:
    events = load_events(settings.events_path)
    upcoming = next_event_after(now, events)
    text = formatter.format_status(
        state, now=now,
        tz_name=settings.display_timezone, chat_id=viewer_chat_id,
    )
    if upcoming is not None:
        text += (
            f"\n\n📅 Ближайшее событие: {upcoming.type} "
            f"{formatter.format_local_full(upcoming.ts, settings.display_timezone)}"
        )
    _safe_send(settings, chat_id_to, text)


def _handle_invite(cmd, user: UserSession, state: State, settings) -> None:
    if user.role != "owner":
        _safe_send(settings, user.chat_id, formatter.format_owner_only())
        return
    target = cmd.target_chat_id
    if target is None:
        _safe_send(settings, user.chat_id, "Использование: /invite &lt;chat_id&gt;")
        return
    if target == user.chat_id:
        _safe_send(settings, user.chat_id, formatter.format_invite_self())
        return
    existing = get_user(state, target)
    if existing is not None:
        _safe_send(settings, user.chat_id, formatter.format_invite_already_member(target))
        return
    new_user = add_user(state, target, role="member")
    _safe_send(settings, user.chat_id, formatter.format_invited(target, name=new_user.name))
    try:
        send_message(
            bot_token=settings.telegram_bot_token,
            chat_id=target,
            text=formatter.format_invite_notify(owner_name=user.name),
        )
    except TelegramBlockedError:
        _safe_send(
            settings, user.chat_id,
            f"⚠ Не удалось уведомить chat_id={target} — он не нажал Start у бота.",
        )
    except Exception as exc:
        log.warning("invite notify failed: %s", exc)


def _handle_budget(cmd, user: UserSession, state: State, settings, now: datetime) -> None:
    """/budget — show или /budget 6000 30d → set."""
    if cmd.budget_target_eur is None:
        # Show
        _safe_send(
            settings, user.chat_id,
            formatter.format_budget_show(state, now=now, tz_name=settings.display_timezone),
        )
        return
    # Set
    state.budget = BudgetState(
        target_eur=cmd.budget_target_eur,
        deadline=now + timedelta(days=cmd.budget_days or 30),
        started_at=now,
    )
    _safe_send(
        settings, user.chat_id,
        formatter.format_budget_set(state, tz_name=settings.display_timezone),
    )


def _handle_budget_done(cmd, user: UserSession, state: State, settings) -> None:
    if not state.budget.active:
        _safe_send(settings, user.chat_id, formatter.format_budget_no_active())
        return
    eur = cmd.budget_done_eur or 0.0
    rate = cmd.budget_done_rate
    if rate is None:
        rate = state.last_score_breakdown.rate if state.last_score_breakdown else 0.0
    record_conversion(state, eur=eur, rate=rate)
    _safe_send(settings, user.chat_id, formatter.format_budget_done(state, eur=eur, rate=rate))


def _handle_quiet(cmd, user: UserSession, state: State, settings) -> None:
    if cmd.quiet_off:
        user.quiet.enabled = False
        _safe_send(settings, user.chat_id, formatter.format_quiet_off())
        return
    if cmd.quiet_from is None or cmd.quiet_to is None:
        _safe_send(
            settings, user.chat_id,
            formatter.format_quiet_show(state, user.chat_id, tz_name=settings.display_timezone),
        )
        return
    user.quiet.enabled = True
    user.quiet.from_hour = cmd.quiet_from
    user.quiet.to_hour = cmd.quiet_to
    _safe_send(
        settings, user.chat_id,
        formatter.format_quiet_set(cmd.quiet_from, cmd.quiet_to, tz_name=settings.display_timezone),
    )


def _handle_digest(cmd, user: UserSession, state: State, settings) -> None:
    if cmd.digest_on is None:
        _safe_send(settings, user.chat_id, formatter.format_digest_show(state, user.chat_id))
        return
    user.digest_enabled = cmd.digest_on
    _safe_send(
        settings, user.chat_id,
        formatter.format_digest_set(
            cmd.digest_on,
            hour=settings.digest_hour,
            minute=settings.digest_minute,
            tz_name=settings.display_timezone,
        ),
    )


def _handle_callback(upd: Update, settings, state: State) -> None:
    """Обработка нажатий inline-кнопок в алертах."""
    user = get_user(state, upd.chat_id)
    if user is None:
        if upd.callback_id:
            answer_callback_query(
                bot_token=settings.telegram_bot_token,
                callback_id=upd.callback_id,
                text="Ты не подписан на бот.",
            )
        return

    parsed: ParsedCallback = parse_callback(upd.callback_data or "")
    log.info("callback chat=%d kind=%s pct=%s dur=%s",
             upd.chat_id, parsed.kind, parsed.pct, parsed.duration)

    now = datetime.now(timezone.utc)

    if parsed.kind == "alert_done_pct" and parsed.pct is not None:
        # Записываем конвертацию (если есть бюджет — сумму считаем от remaining)
        rate = state.last_score_breakdown.rate if state.last_score_breakdown else 0.0
        if state.budget.active and state.budget.target_eur is not None:
            eur = state.budget.remaining_eur * parsed.pct / 100
            if eur > 0 and rate > 0:
                record_conversion(state, eur=eur, rate=rate, pct_at_alert=parsed.pct)
                toast = formatter.format_callback_done(eur, rate, parsed.pct)
            else:
                toast = formatter.format_callback_done_no_budget(parsed.pct)
        else:
            toast = formatter.format_callback_done_no_budget(parsed.pct)

        if upd.callback_id:
            answer_callback_query(
                bot_token=settings.telegram_bot_token,
                callback_id=upd.callback_id,
                text="Записал ✅",
            )
        # Удаляем кнопки чтобы не нажали ещё раз, и шлём подтверждение
        if upd.message_id is not None:
            edit_message_reply_markup(
                bot_token=settings.telegram_bot_token,
                chat_id=upd.chat_id,
                message_id=upd.message_id,
                inline_keyboard=None,
            )
        _safe_send(settings, upd.chat_id, toast)
        return

    if parsed.kind == "alert_silence" and parsed.duration is not None:
        until = now + parsed.duration
        user.silence.active = True
        user.silence.until = until
        user.silence.reason = "manual"
        if upd.callback_id:
            answer_callback_query(
                bot_token=settings.telegram_bot_token,
                callback_id=upd.callback_id,
                text="Silence ✅",
            )
        if upd.message_id is not None:
            edit_message_reply_markup(
                bot_token=settings.telegram_bot_token,
                chat_id=upd.chat_id,
                message_id=upd.message_id,
                inline_keyboard=None,
            )
        period_label = _format_period(parsed.duration)
        _safe_send(settings, upd.chat_id, formatter.format_callback_silenced(period_label))
        return

    if upd.callback_id:
        answer_callback_query(
            bot_token=settings.telegram_bot_token,
            callback_id=upd.callback_id,
            text="Неизвестная кнопка.",
        )


def _format_period(duration: timedelta) -> str:
    seconds = int(duration.total_seconds())
    if seconds % 86400 == 0:
        days = seconds // 86400
        return f"{days}d"
    if seconds % 3600 == 0:
        hours = seconds // 3600
        return f"{hours}h"
    return f"{seconds}s"


def _safe_send(settings, chat_id: int, text: str) -> None:
    try:
        send_message(
            bot_token=settings.telegram_bot_token,
            chat_id=chat_id,
            text=text,
        )
    except TelegramBlockedError as exc:
        log.warning("Telegram 403 (chat=%d): %s", chat_id, exc)
    except TelegramAuthError:
        raise
    except Exception as exc:
        log.exception("send_message (chat=%d) failed: %s", chat_id, exc)


def _push_state(repo_root, message: str) -> None:
    try:
        git_sync.commit_and_push(repo_root, "state.json", message=message)
    except git_sync.GitSyncError as exc:
        log.error("git sync failed: %s", exc)


if __name__ == "__main__":
    sys.exit(main())

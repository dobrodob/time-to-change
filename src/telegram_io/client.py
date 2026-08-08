"""Минимальный клиент Telegram Bot API.

API: sendMessage (с inline_keyboard), getUpdates (message + callback_query),
answerCallbackQuery, editMessageReplyMarkup, setMyCommands.

Сознательно не используем python-telegram-bot — для cron-cycle нужен только
синхронный httpx вызов с retry, без event loop'а.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import Any

import httpx

log = logging.getLogger(__name__)


class TelegramError(RuntimeError):
    pass


class TelegramAuthError(TelegramError):
    """401 — токен невалиден / отозван."""


class TelegramBlockedError(TelegramError):
    """403 — бот заблокирован пользователем."""


@dataclass(frozen=True)
class Update:
    """Объединённый Update — либо message, либо callback_query.

    Если update_kind == 'callback' → message_id указывает на сообщение,
    под которым нажата кнопка (для editMessageReplyMarkup).
    """
    update_id: int
    chat_id: int
    text: str
    sender_id: int | None
    sender_name: str | None = None
    update_kind: str = "message"  # "message" | "callback"
    callback_id: str | None = None
    callback_data: str | None = None
    message_id: int | None = None  # для callback — id сообщения с inline-клавиатурой


# --- send / edit ---


def send_message(
    *,
    bot_token: str,
    chat_id: int,
    text: str,
    parse_mode: str = "HTML",
    inline_keyboard: list[list[dict[str, str]]] | None = None,
    timeout: float = 15.0,
    max_retries: int = 3,
) -> int | None:
    """Отправляет сообщение. Возвращает message_id (для последующего edit)."""
    url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
    payload: dict[str, Any] = {
        "chat_id": chat_id,
        "text": text,
        "parse_mode": parse_mode,
        "disable_web_page_preview": True,
    }
    if inline_keyboard is not None:
        payload["reply_markup"] = {"inline_keyboard": inline_keyboard}

    delay = 2.0
    for attempt in range(1, max_retries + 1):
        try:
            with httpx.Client(timeout=timeout) as client:
                resp = client.post(url, json=payload)
            _raise_for_telegram(resp)
            data = resp.json()
            return data.get("result", {}).get("message_id")
        except (TelegramAuthError, TelegramBlockedError):
            raise
        except (httpx.TransportError, TelegramError) as exc:
            log.warning("Telegram sendMessage attempt %d failed: %s", attempt, exc)
            if attempt < max_retries:
                time.sleep(delay)
                delay *= 2
            else:
                raise
    return None


def edit_message_reply_markup(
    *,
    bot_token: str,
    chat_id: int,
    message_id: int,
    inline_keyboard: list[list[dict[str, str]]] | None,
    timeout: float = 15.0,
) -> None:
    """Меняет (или убирает) inline-клавиатуру у уже отправленного сообщения."""
    url = f"https://api.telegram.org/bot{bot_token}/editMessageReplyMarkup"
    payload: dict[str, Any] = {"chat_id": chat_id, "message_id": message_id}
    if inline_keyboard is not None:
        payload["reply_markup"] = {"inline_keyboard": inline_keyboard}
    else:
        payload["reply_markup"] = {"inline_keyboard": []}
    try:
        with httpx.Client(timeout=timeout) as client:
            resp = client.post(url, json=payload)
        _raise_for_telegram(resp)
    except TelegramError as exc:
        # 400 'message is not modified' — норма (повторный клик)
        log.warning("editMessageReplyMarkup: %s", exc)


def answer_callback_query(
    *,
    bot_token: str,
    callback_id: str,
    text: str | None = None,
    timeout: float = 15.0,
) -> None:
    """Закрывает loading-state у юзера в Telegram + опциональный toast."""
    url = f"https://api.telegram.org/bot{bot_token}/answerCallbackQuery"
    payload: dict[str, Any] = {"callback_query_id": callback_id}
    if text:
        payload["text"] = text[:200]  # Telegram лимит
        payload["show_alert"] = False
    try:
        with httpx.Client(timeout=timeout) as client:
            resp = client.post(url, json=payload)
        _raise_for_telegram(resp)
    except TelegramError as exc:
        log.warning("answerCallbackQuery: %s", exc)


# --- getUpdates ---


def get_updates(
    *,
    bot_token: str,
    offset: int,
    timeout_long_poll: int = 0,
    timeout: float = 15.0,
    limit: int = 100,
) -> list[Update]:
    """Тянет обновления (message + callback_query)."""
    url = f"https://api.telegram.org/bot{bot_token}/getUpdates"
    params: dict[str, str] = {
        "offset": str(offset),
        "timeout": str(timeout_long_poll),
        "limit": str(limit),
        "allowed_updates": '["message", "callback_query"]',
    }
    with httpx.Client(timeout=timeout + timeout_long_poll + 5) as client:
        resp = client.get(url, params=params)
    _raise_for_telegram(resp)
    payload = resp.json()
    if not payload.get("ok"):
        raise TelegramError(f"getUpdates not ok: {payload}")
    parsed: list[Update] = []
    for item in payload.get("result", []):
        upd = _parse_update(item)
        if upd is not None:
            parsed.append(upd)
    return parsed


def _raise_for_telegram(resp: httpx.Response) -> None:
    if resp.status_code == 401:
        raise TelegramAuthError(f"401 unauthorized: {resp.text}")
    if resp.status_code == 403:
        raise TelegramBlockedError(f"403 forbidden: {resp.text}")
    if resp.status_code == 409:
        raise TelegramError(f"409 conflict: {resp.text}")
    if resp.status_code >= 500:
        raise TelegramError(f"{resp.status_code} server: {resp.text[:200]}")
    if resp.status_code >= 400:
        raise TelegramError(f"{resp.status_code} client: {resp.text[:200]}")


def _parse_update(raw: dict[str, Any]) -> Update | None:
    update_id = int(raw["update_id"])

    # callback_query (нажата inline-кнопка)
    cb = raw.get("callback_query")
    if isinstance(cb, dict):
        sender = cb.get("from") or {}
        msg = cb.get("message") or {}
        chat = msg.get("chat") or {}
        chat_id = chat.get("id")
        if chat_id is None:
            return None
        sender_id = sender.get("id")
        return Update(
            update_id=update_id,
            chat_id=int(chat_id),
            text="",
            sender_id=int(sender_id) if sender_id is not None else None,
            sender_name=_full_name(sender),
            update_kind="callback",
            callback_id=cb.get("id"),
            callback_data=cb.get("data"),
            message_id=msg.get("message_id"),
        )

    msg = raw.get("message")
    if not isinstance(msg, dict):
        return None
    chat = msg.get("chat") or {}
    chat_id = chat.get("id")
    text = msg.get("text")
    if chat_id is None or text is None:
        return None
    sender = msg.get("from") or {}
    sender_id = sender.get("id")
    return Update(
        update_id=update_id,
        chat_id=int(chat_id),
        text=str(text),
        sender_id=int(sender_id) if sender_id is not None else None,
        sender_name=_full_name(sender),
        update_kind="message",
        message_id=msg.get("message_id"),
    )


def _full_name(sender: dict[str, Any]) -> str | None:
    first = sender.get("first_name") or ""
    last = sender.get("last_name") or ""
    username = sender.get("username")
    full = f"{first} {last}".strip()
    if full:
        return full
    if username:
        return f"@{username}"
    return None


# --- bot config ---


def set_my_commands(
    *,
    bot_token: str,
    commands: list[tuple[str, str]],
    timeout: float = 15.0,
) -> None:
    """Регистрирует список команд (Telegram → синяя кнопка `/`).

    Idempotent — Telegram перезаписывает старый список.
    """
    url = f"https://api.telegram.org/bot{bot_token}/setMyCommands"
    payload = {"commands": [{"command": c, "description": d} for c, d in commands]}
    with httpx.Client(timeout=timeout) as client:
        resp = client.post(url, json=payload)
    _raise_for_telegram(resp)

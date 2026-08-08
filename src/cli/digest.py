"""Утренний дайджест в DIGEST_HOUR_LOCAL:DIGEST_MINUTE_LOCAL (по DISPLAY_TIMEZONE).

Workflow запускается за окно вокруг целевого времени (DST колеблется).
Скрипт сам решает выйти, если не попал в окно ±DIGEST_TOLERANCE_MIN.

Idempotency: если за последние 12h уже отправляли — выходит, чтобы не
задублировать (на случай если cron сработал дважды в DST-крае).
"""

from __future__ import annotations

import logging
import sys
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from src.alerts import formatter
from src.alerts.gating import compute_edge_pct
from src.analysis import scoring
from src.config import get_settings
from src.data import twelvedata_client
from src.data.market_calendar import is_market_open
from src.state import git_sync
from src.state.store import (
    expire_silences_if_due,
    load_state,
    save_state,
)
from src.telegram_io.client import TelegramAuthError, TelegramBlockedError, send_message

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s | %(message)s")
log = logging.getLogger("digest")


def main() -> int:
    settings = get_settings()
    if not settings.telegram_bot_token:
        log.error("TELEGRAM_BOT_TOKEN не задан")
        return 1

    now = datetime.now(timezone.utc)
    try:
        local = now.astimezone(ZoneInfo(settings.display_timezone))
    except Exception:
        log.error("Невалидная DISPLAY_TIMEZONE %r", settings.display_timezone)
        return 1

    target = local.replace(
        hour=settings.digest_hour,
        minute=settings.digest_minute,
        second=0,
        microsecond=0,
    )
    diff_min = abs((local - target).total_seconds() / 60)
    if diff_min > settings.digest_tolerance_min:
        log.info(
            "Сейчас %s — не время для дайджеста (целевой %02d:%02d ±%d min, diff=%.0f)",
            local.strftime("%H:%M"),
            settings.digest_hour, settings.digest_minute,
            settings.digest_tolerance_min, diff_min,
        )
        return 0

    state = load_state(settings.state_path)
    state = expire_silences_if_due(state, now=now)

    # Idempotency: если за последние 12h уже отправляли — выходим
    if state.last_digest_at is not None and (now - state.last_digest_at) < timedelta(hours=12):
        log.info("Дайджест уже был сегодня в %s, пропускаем", state.last_digest_at.isoformat())
        return 0

    # Берём свежий курс если рынок открыт, иначе digest без свежих данных
    breakdown = None
    edge_pct = None
    if is_market_open(now) and state.quota.twelvedata_credits_used_today < settings.twelvedata_credits_warn_at:
        try:
            daily_result = twelvedata_client.fetch_time_series(
                api_key=settings.twelvedata_api_key,
                symbol=settings.symbol,
                interval="1day",
                outputsize=settings.daily_bars,
            )
            hourly_result = twelvedata_client.fetch_time_series(
                api_key=settings.twelvedata_api_key,
                symbol=settings.symbol,
                interval="1h",
                outputsize=settings.hourly_bars,
            )
            state.quota.twelvedata_credits_used_today += daily_result.credits_used + hourly_result.credits_used
            daily_df = daily_result.df.set_index("datetime").sort_index()
            hourly_df = hourly_result.df.set_index("datetime").sort_index()
            breakdown = scoring.compute_score(daily_df, hourly_df)
            edge_pct = compute_edge_pct(breakdown.rate, state.baseline.rolling_median_30d)
        except Exception as exc:
            log.warning("Не удалось получить свежие данные для дайджеста: %s — используем последний breakdown", exc)
            breakdown = None
            edge_pct = None

    # Если не получили fresh — используем last_score_breakdown как fallback
    if breakdown is None and state.last_score_breakdown is not None:
        breakdown = scoring.ScoreBreakdown(
            score=state.last_score_breakdown.score,
            regime=state.last_score_breakdown.regime,  # type: ignore[arg-type]
            rate=state.last_score_breakdown.rate,
            components=state.last_score_breakdown.components,
            notes=state.last_score_breakdown.notes,
        )
        edge_pct = state.last_score_breakdown.edge_pct

    text = formatter.format_digest(
        state, breakdown=breakdown, edge_pct=edge_pct,
        now=now, tz_name=settings.display_timezone,
    )

    sent = 0
    for user in state.telegram.users:
        if not user.digest_enabled:
            continue
        try:
            send_message(
                bot_token=settings.telegram_bot_token,
                chat_id=user.chat_id,
                text=text,
            )
            sent += 1
        except TelegramAuthError as exc:
            log.error("Telegram 401: %s", exc)
            return 1
        except TelegramBlockedError as exc:
            log.warning("Telegram 403 (chat_id=%d): %s", user.chat_id, exc)
        except Exception as exc:
            log.exception("Digest send (chat_id=%d) failed: %s", user.chat_id, exc)

    log.info("Дайджест отправлен %d/%d пользователям", sent, len(state.telegram.users))
    state.last_digest_at = now
    save_state(state, settings.state_path)
    _push_state(settings.repo_root, f"chore(state): digest sent to {sent} user(s)")
    return 0


def _push_state(repo_root, message: str) -> None:
    try:
        git_sync.commit_and_push(repo_root, "state.json", message=message)
    except git_sync.GitSyncError as exc:
        log.error("git sync failed: %s", exc)


if __name__ == "__main__":
    sys.exit(main())

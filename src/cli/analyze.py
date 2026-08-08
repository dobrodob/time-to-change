"""Часовой оркестратор: fetch → score → gate → send → persist.

Multi-user рассылка с учётом silence, quiet hours и pacing-aware рекомендаций
по бюджету (если он установлен). После compute_score сохраняется
last_score_breakdown для команды /explain.
"""

from __future__ import annotations

import logging
import sys
from datetime import datetime, timedelta, timezone

from src.alerts import formatter, gating
from src.analysis import scoring
from src.config import get_settings
from src.data import twelvedata_client
from src.data.market_calendar import is_market_open
from src.events.filter import load_events
from src.state import git_sync
from src.state.store import (
    AlertRecord,
    LastScoreBreakdown,
    State,
    append_alert,
    expire_silences_if_due,
    is_quiet_for,
    is_silenced_for,
    load_state,
    save_state,
)
from src.telegram_io.client import TelegramAuthError, TelegramBlockedError, send_message

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s | %(message)s")
log = logging.getLogger("analyze")


def main() -> int:
    settings = get_settings()
    now = datetime.now(timezone.utc)
    state = load_state(settings.state_path)
    state = _maybe_reset_quota(state, now)
    state = expire_silences_if_due(state, now=now)

    if not is_market_open(now):
        log.info("Рынок закрыт (UTC %s) — пропускаем анализ", now.isoformat())
        save_state(state, settings.state_path)
        _push_state(settings.repo_root, "chore(state): mark market-closed tick")
        return 0

    if state.quota.twelvedata_credits_used_today >= settings.twelvedata_credits_warn_at:
        log.warning(
            "Quota %d/%d приближается к лимиту, throttle до полуночи UTC",
            state.quota.twelvedata_credits_used_today,
            settings.twelvedata_credits_daily_cap,
        )
        save_state(state, settings.state_path)
        _push_state(settings.repo_root, "chore(state): quota throttle")
        return 0

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
    except twelvedata_client.TwelveDataQuotaError as exc:
        log.error("Quota error: %s", exc)
        state.quota.twelvedata_credits_used_today = settings.twelvedata_credits_daily_cap
        save_state(state, settings.state_path)
        _push_state(settings.repo_root, "chore(state): quota exhausted")
        return 0
    except twelvedata_client.TwelveDataError as exc:
        log.error("Twelve Data fetch failed: %s", exc)
        state.consecutive_failures += 1
        save_state(state, settings.state_path)
        if state.consecutive_failures == 3:
            _broadcast_warning(settings, state, "⚠ Не могу получить данные EUR/USD уже 3 часа подряд. Проверь GitHub Actions logs.")
        _push_state(settings.repo_root, "chore(state): fetch failure")
        return 0

    state.consecutive_failures = 0
    state.quota.twelvedata_credits_used_today += daily_result.credits_used + hourly_result.credits_used

    daily_df = daily_result.df.set_index("datetime").sort_index()
    hourly_df = hourly_result.df.set_index("datetime").sort_index()
    breakdown = scoring.compute_score(daily_df, hourly_df)
    log.info(
        "Score=%.1f regime=%s rate=%.5f components=%s",
        breakdown.score, breakdown.regime, breakdown.rate, breakdown.components,
    )

    closes_30 = daily_df["close"].dropna().tail(30)
    closes_90 = daily_df["close"].dropna().tail(90)
    if not closes_30.empty:
        state.baseline.rolling_median_30d = float(closes_30.median())
    if not closes_90.empty:
        state.baseline.rolling_p90_90d = float(closes_90.quantile(0.90))
    state.baseline.computed_at = now

    edge_pct = gating.compute_edge_pct(breakdown.rate, state.baseline.rolling_median_30d)
    events = load_events(settings.events_path)
    decision = gating.decide(
        state=state,
        new_regime=breakdown.regime,
        edge_pct=edge_pct,
        events=events,
        min_edge_pct=settings.min_edge_pct,
        cooldown_hours=settings.cooldown_hours,
        now=now,
    )
    log.info("Gate decision: allow=%s reason=%s", decision.allow, decision.reason)

    # Сохраняем breakdown для /explain (включая случаи когда не отправили)
    state.last_score_breakdown = LastScoreBreakdown(
        ts=now,
        score=breakdown.score,
        regime=breakdown.regime,
        rate=breakdown.rate,
        edge_pct=edge_pct,
        components={k: (float(v) if v is not None else None) for k, v in breakdown.components.items()},
        notes=list(breakdown.notes),
        was_alert=decision.allow,
        gate_reason=None if decision.allow else decision.reason,
    )

    if decision.allow:
        text = formatter.format_alert(
            breakdown, edge_pct, now=now,
            tz_name=settings.display_timezone,
            budget=state.budget if state.budget.active else None,
        )
        keyboard = formatter.alert_inline_keyboard(
            breakdown=breakdown,
            budget=state.budget if state.budget.active else None,
            now=now,
        )

        recipients = [
            u for u in state.telegram.users
            if not is_silenced_for(u, now=now)
            and not is_quiet_for(u, now=now, tz_name=settings.display_timezone)
        ]
        log.info(
            "Рассылка %d/%d users (silence/quiet отфильтрованы)",
            len(recipients), len(state.telegram.users),
        )

        if recipients:
            for user in recipients:
                try:
                    send_message(
                        bot_token=settings.telegram_bot_token,
                        chat_id=user.chat_id,
                        text=text,
                        inline_keyboard=keyboard,
                    )
                except TelegramAuthError as exc:
                    log.error("Telegram 401: %s", exc)
                    save_state(state, settings.state_path)
                    _push_state(settings.repo_root, "chore(state): post-fetch (TG 401)")
                    return 1
                except TelegramBlockedError as exc:
                    log.warning("Telegram 403 (chat_id=%d): %s", user.chat_id, exc)
                except Exception as exc:
                    log.exception("Telegram send (chat_id=%d) failed: %s", user.chat_id, exc)

            state = append_alert(
                state,
                AlertRecord(
                    ts=now,
                    regime=breakdown.regime,
                    score=breakdown.score,
                    rate=breakdown.rate,
                    edge_pct=edge_pct,
                ),
            )
        elif state.telegram.users:
            log.info("Все users в silence/quiet — alert не отправлен, но regime зафиксирован для cooldown")
            state = append_alert(
                state,
                AlertRecord(
                    ts=now,
                    regime=breakdown.regime,
                    score=breakdown.score,
                    rate=breakdown.rate,
                    edge_pct=edge_pct,
                ),
            )
        else:
            log.info("Пока нет users — алерт пропущен")

    save_state(state, settings.state_path)
    _push_state(settings.repo_root, f"chore(state): tick score={breakdown.score:.1f} regime={breakdown.regime}")
    return 0


def _maybe_reset_quota(state: State, now: datetime) -> State:
    reset_at = state.quota.reset_at
    if reset_at is None or now >= reset_at:
        next_midnight = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
        state.quota.twelvedata_credits_used_today = 0
        state.quota.reset_at = next_midnight
    return state


def _push_state(repo_root, message: str) -> None:
    try:
        git_sync.commit_and_push(repo_root, "state.json", message=message)
    except git_sync.GitSyncError as exc:
        log.error("git sync failed: %s", exc)


def _broadcast_warning(settings, state: State, text: str) -> None:
    for user in state.telegram.users:
        try:
            send_message(
                bot_token=settings.telegram_bot_token,
                chat_id=user.chat_id,
                text=text,
            )
        except Exception as exc:
            log.warning("Warning не дошёл до chat_id=%d: %s", user.chat_id, exc)


if __name__ == "__main__":
    sys.exit(main())

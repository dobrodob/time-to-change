"""Walk-forward бэктест: применяем live scoring к исторической серии.

Никакой look-ahead'а: на каждом часовом тике передаём в scoring slice
данных «до этого момента включительно».

Сравниваемся с baseline — «менять 1/N от стартового баланса каждую пятницу
16:00 UTC» (Friday close — стандартная weekly anchor).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta

import pandas as pd

from src.analysis.scoring import (
    Regime,
    ScoreBreakdown,
    compute_score,
    regime_rank,
)

log = logging.getLogger("backtest.engine")

# Доли конвертации по regime
CONVERSION_PCT: dict[str, float] = {
    "cooldown": 0.0,
    "watch": 0.0,
    "partial": 0.30,
    "strong": 0.50,
}


@dataclass
class TickResult:
    ts: datetime
    rate: float
    score: float
    regime: str
    edge_pct: float
    alerted: bool
    converted_eur: float
    received_usd: float


@dataclass
class BacktestResult:
    ticks: list[TickResult]
    strategy_total_usd: float
    baseline_total_usd: float
    starting_eur: float
    alerts_count: int
    avg_alert_rate: float  # средний rate в моменты алертов


def run_backtest(
    daily: pd.DataFrame,
    hourly: pd.DataFrame,
    *,
    starting_eur: float = 1000.0,
    min_edge_pct: float = 2.5,
    cooldown_hours: int = 24,
    daily_warmup: int = 250,
    hourly_warmup: int = 60,
) -> BacktestResult:
    """Прогоняет правила на истории и возвращает результат симуляции."""
    if "datetime" in daily.columns:
        daily = daily.set_index("datetime").sort_index()
    if "datetime" in hourly.columns:
        hourly = hourly.set_index("datetime").sort_index()

    daily_close = daily["close"].dropna()
    hourly_index = hourly.index

    ticks: list[TickResult] = []
    strategy_eur_remaining = starting_eur
    strategy_usd_received = 0.0
    last_regime: Regime | None = None
    last_alert_ts: datetime | None = None
    alert_rates: list[float] = []

    for ts in hourly_index:
        # окно daily — все бары до ts включительно
        daily_slice = daily_close[daily_close.index <= ts]
        hourly_slice = hourly.loc[:ts]

        if len(daily_slice) < daily_warmup or len(hourly_slice) < hourly_warmup:
            continue

        # baseline median 30d на этом тике
        median_30 = float(daily_slice.tail(30).median())

        breakdown: ScoreBreakdown = compute_score(daily.loc[:ts], hourly_slice)
        rate = breakdown.rate
        regime = breakdown.regime
        edge_pct = (rate - median_30) / median_30 * 100.0 if median_30 > 0 else 0.0

        alerted = False
        converted_eur = 0.0
        received_usd = 0.0
        if regime in ("partial", "strong") and edge_pct >= min_edge_pct:
            within_cooldown = (
                last_alert_ts is not None
                and (ts - last_alert_ts) < timedelta(hours=cooldown_hours)
            )
            new_rank = regime_rank(regime)
            old_rank = regime_rank(last_regime)
            if not within_cooldown or new_rank > old_rank:
                # Алерт срабатывает
                alerted = True
                last_regime = regime
                last_alert_ts = ts
                alert_rates.append(rate)

                pct = CONVERSION_PCT[regime]
                converted_eur = strategy_eur_remaining * pct
                strategy_eur_remaining -= converted_eur
                received_usd = converted_eur * rate
                strategy_usd_received += received_usd

        ticks.append(
            TickResult(
                ts=ts,
                rate=rate,
                score=breakdown.score,
                regime=regime,
                edge_pct=edge_pct,
                alerted=alerted,
                converted_eur=converted_eur,
                received_usd=received_usd,
            )
        )

    # Если что-то осталось EUR — конвертируем по последнему rate
    if strategy_eur_remaining > 0 and ticks:
        final_rate = ticks[-1].rate
        strategy_usd_received += strategy_eur_remaining * final_rate

    # Baseline: каждую пятницу 16:00 UTC (если найдём ближайший hourly bar) конвертим 1/N
    baseline_total_usd = _baseline_weekly(hourly, starting_eur)

    avg_alert_rate = (sum(alert_rates) / len(alert_rates)) if alert_rates else 0.0

    return BacktestResult(
        ticks=ticks,
        strategy_total_usd=strategy_usd_received,
        baseline_total_usd=baseline_total_usd,
        starting_eur=starting_eur,
        alerts_count=len(alert_rates),
        avg_alert_rate=avg_alert_rate,
    )


def _baseline_weekly(hourly: pd.DataFrame, starting_eur: float) -> float:
    """Стратегия «менять 1/N каждую пятницу 16:00 UTC»."""
    fridays: list[pd.Timestamp] = []
    for ts in hourly.index:
        # weekday=4 пятница, hour=16 — поставим >= 16 чтобы взять ближайший доступный бар после
        if ts.weekday() == 4 and ts.hour == 16:
            fridays.append(ts)

    if not fridays:
        return 0.0

    n = len(fridays)
    chunk = starting_eur / n
    total_usd = 0.0
    for ts in fridays:
        rate = float(hourly.loc[ts, "close"])
        total_usd += chunk * rate
    return total_usd

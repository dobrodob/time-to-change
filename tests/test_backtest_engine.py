"""Тесты walk-forward бэктеста."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd

from src.backtest.engine import CONVERSION_PCT, run_backtest


def _build_history(days_daily: int = 400, hours_hourly: int = 1000):
    """Синтетика: восходящая daily + восходящая hourly, согласованные."""
    rng = np.random.default_rng(42)

    daily_start = datetime(2024, 1, 1, tzinfo=timezone.utc)
    daily_close = np.linspace(1.05, 1.12, days_daily) + rng.normal(0, 0.002, days_daily)
    daily = pd.DataFrame({
        "datetime": [daily_start + timedelta(days=i) for i in range(days_daily)],
        "open": daily_close,
        "high": daily_close + 0.001,
        "low": daily_close - 0.001,
        "close": daily_close,
    })

    hourly_start = daily_start + timedelta(days=days_daily - 60)  # последние ~60 дней
    hourly_close = np.linspace(1.10, 1.13, hours_hourly) + rng.normal(0, 0.0008, hours_hourly)
    hourly = pd.DataFrame({
        "datetime": [hourly_start + timedelta(hours=i) for i in range(hours_hourly)],
        "open": hourly_close,
        "high": hourly_close + 0.0006,
        "low": hourly_close - 0.0006,
        "close": hourly_close,
    })
    return daily, hourly


def test_backtest_runs_without_error():
    daily, hourly = _build_history()
    result = run_backtest(daily, hourly, starting_eur=1000.0, min_edge_pct=2.5)
    assert result.starting_eur == 1000.0
    assert len(result.ticks) > 0
    assert result.strategy_total_usd > 0
    # Baseline тоже посчитался (если есть пятничные бары)
    assert result.baseline_total_usd >= 0


def test_backtest_no_lookahead():
    """Проверяем, что bar t использует только данные до t включительно.

    Идея: вставим аномально-высокий close в самом конце hourly; алерт по
    позициям до аномалии не должен 'предчувствовать' её.
    """
    daily, hourly = _build_history(days_daily=400, hours_hourly=200)
    # Для убедительности — пометим hourly['close'].iloc[-1] аномалией
    hourly.loc[hourly.index[-1], "close"] = 2.0  # абсурд
    result = run_backtest(daily, hourly, min_edge_pct=2.5)
    # Tick'и до последнего не должны видеть rate=2.0
    rates_before_last = [t.rate for t in result.ticks[:-1] if not pd.isna(t.rate)]
    if rates_before_last:
        assert max(rates_before_last) < 1.5


def test_backtest_warmup_skipped():
    """На короткой истории большинство тиков пропускается (warmup)."""
    daily, hourly = _build_history(days_daily=120, hours_hourly=50)
    result = run_backtest(daily, hourly, daily_warmup=250)
    # daily короче warmup → ticks пустой
    assert len(result.ticks) == 0


def test_backtest_conversion_pcts_sane():
    assert CONVERSION_PCT["partial"] == 0.30
    assert CONVERSION_PCT["strong"] == 0.50
    assert CONVERSION_PCT["watch"] == 0.0
    assert CONVERSION_PCT["cooldown"] == 0.0

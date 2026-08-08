"""Тесты технических индикаторов."""

from __future__ import annotations

import math

import numpy as np
import pandas as pd

from src.analysis.indicators import (
    atr,
    bollinger_bands,
    ema,
    macd_histogram,
    percentile_rank,
    rsi,
    sma,
)


def test_ema_constant_series_equals_constant():
    s = pd.Series([2.0] * 50)
    result = ema(s, 10)
    # После прогрева EMA от константы — та же константа
    assert _close(result.iloc[-1], 2.0)


def test_sma_window_size():
    s = pd.Series(range(100), dtype=float)
    result = sma(s, 10)
    # SMA(0..9) на 9-й позиции = 4.5
    assert _close(result.iloc[9], 4.5)
    # До window-1 — NaN
    assert pd.isna(result.iloc[8])


def test_rsi_range_0_100():
    rng = np.random.default_rng(7)
    s = pd.Series(rng.normal(0, 1, 200).cumsum() + 100)
    result = rsi(s, 14).dropna()
    assert (result >= 0).all() and (result <= 100).all()


def test_rsi_uptrend_high():
    """Чисто-восходящая серия → RSI должен быть высоким (близко к 100)."""
    s = pd.Series(np.arange(100, 200, dtype=float))
    result = rsi(s, 14)
    # На монотонно растущей серии все delta положительные → loss=0 → RSI=100
    assert result.iloc[-1] == 100.0


def test_macd_zero_for_constant():
    s = pd.Series([1.5] * 100)
    result = macd_histogram(s)
    # Константа → MACD = 0, histogram = 0
    assert _close(result.iloc[-1], 0.0)


def test_bollinger_bands_widths_positive():
    rng = np.random.default_rng(11)
    s = pd.Series(rng.normal(1.08, 0.005, 100))
    lower, middle, upper = bollinger_bands(s, window=20, num_std=2.0)
    diff = (upper - lower).dropna()
    assert (diff > 0).all()
    # middle между lower и upper
    assert ((middle.dropna() <= upper.dropna()) & (middle.dropna() >= lower.dropna())).all()


def test_atr_positive():
    rng = np.random.default_rng(13)
    n = 100
    close = pd.Series(rng.normal(1.08, 0.005, n))
    high = close + np.abs(rng.normal(0, 0.001, n))
    low = close - np.abs(rng.normal(0, 0.001, n))
    result = atr(high, low, close, window=14).dropna()
    assert (result > 0).all()


def test_percentile_rank_sane():
    s = pd.Series([1.0, 2.0, 3.0, 4.0, 5.0])
    # 3.5 выше 3 значений (1, 2, 3) → 60%
    assert percentile_rank(s, 3.5) == 60.0
    assert percentile_rank(s, 10.0) == 100.0
    assert percentile_rank(s, 0.0) == 0.0


def test_percentile_rank_empty():
    s = pd.Series([], dtype=float)
    assert pd.isna(percentile_rank(s, 1.0))


# ---

def _close(a: float, b: float, *, atol: float = 1e-8) -> bool:
    return math.isclose(a, b, abs_tol=atol)

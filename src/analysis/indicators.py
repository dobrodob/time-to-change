"""Технические индикаторы. Pure-функции на pd.Series.

Все функции возвращают pd.Series длины как у входа. Если данных не хватает
для расчёта (короче N бар), возвращается серия с NaN в начале — это
нормальное поведение, gating layer проверяет наличие валидного значения
в последней позиции.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

__all__ = [
    "atr",
    "bollinger_bands",
    "ema",
    "macd_histogram",
    "percentile_rank",
    "rsi",
    "sma",
]


def ema(series: pd.Series, window: int) -> pd.Series:
    """Exponential Moving Average. Стандартная формула с alpha=2/(window+1)."""
    return series.ewm(span=window, adjust=False, min_periods=window).mean()


def sma(series: pd.Series, window: int) -> pd.Series:
    """Simple Moving Average."""
    return series.rolling(window=window, min_periods=window).mean()


def rsi(close: pd.Series, window: int = 14) -> pd.Series:
    """RSI по Wilder'у (rolling mean, эквивалент EMA с alpha=1/window).

    Возвращает значения в [0, 100]. NaN для первых window баров.
    """
    delta = close.diff()
    gain = delta.where(delta > 0, 0.0)
    loss = -delta.where(delta < 0, 0.0)

    # Wilder's smoothing: EMA с alpha = 1/window
    avg_gain = gain.ewm(alpha=1.0 / window, adjust=False, min_periods=window).mean()
    avg_loss = loss.ewm(alpha=1.0 / window, adjust=False, min_periods=window).mean()

    rs = avg_gain / avg_loss.replace(0, np.nan)
    rsi_value = 100.0 - (100.0 / (1.0 + rs))
    # Защита от деления на ноль (если loss=0 ровно)
    rsi_value = rsi_value.where(avg_loss > 0, 100.0)
    return rsi_value


def macd_histogram(
    close: pd.Series,
    fast: int = 12,
    slow: int = 26,
    signal: int = 9,
) -> pd.Series:
    """MACD histogram = MACD line − signal line.

    MACD line = EMA(fast) − EMA(slow)
    signal line = EMA(MACD, signal)
    histogram > 0: бычий импульс. Растущий histogram: ускорение.
    """
    macd_line = ema(close, fast) - ema(close, slow)
    signal_line = ema(macd_line, signal)
    return macd_line - signal_line


def bollinger_bands(
    close: pd.Series,
    window: int = 20,
    num_std: float = 2.0,
) -> tuple[pd.Series, pd.Series, pd.Series]:
    """Bollinger Bands: (lower, middle, upper).

    middle = SMA(window). lower/upper = middle ∓ num_std * stdev.
    """
    middle = sma(close, window)
    std = close.rolling(window=window, min_periods=window).std(ddof=0)
    upper = middle + num_std * std
    lower = middle - num_std * std
    return lower, middle, upper


def atr(
    high: pd.Series,
    low: pd.Series,
    close: pd.Series,
    window: int = 14,
) -> pd.Series:
    """Average True Range по Wilder'у.

    True Range = max(high-low, |high-close_prev|, |low-close_prev|).
    """
    prev_close = close.shift(1)
    tr1 = high - low
    tr2 = (high - prev_close).abs()
    tr3 = (low - prev_close).abs()
    true_range = pd.concat([tr1, tr2, tr3], axis=1).max(axis=1)
    return true_range.ewm(alpha=1.0 / window, adjust=False, min_periods=window).mean()


def percentile_rank(series: pd.Series, value: float) -> float:
    """Перцентиль `value` относительно `series` (доля точек < value, в %).

    NaN-значения игнорируются. Если все значения NaN или серия пуста —
    возвращает NaN.
    """
    clean = series.dropna()
    if clean.empty:
        return float("nan")
    return float((clean < value).mean() * 100.0)

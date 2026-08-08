"""Общие фикстуры. Все тесты — pure (без сети, без часов)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd
import pytest


@pytest.fixture
def synthetic_daily() -> pd.DataFrame:
    """260 дневных бар с восходящим трендом 1.05 → 1.10."""
    rng = np.random.default_rng(seed=42)
    n = 260
    base = np.linspace(1.05, 1.10, n)
    noise = rng.normal(0, 0.0015, n)
    closes = base + noise
    high = closes + np.abs(rng.normal(0, 0.001, n))
    low = closes - np.abs(rng.normal(0, 0.001, n))
    opens = closes - rng.normal(0, 0.0008, n)

    start = datetime(2025, 1, 1, tzinfo=timezone.utc)
    timestamps = [start + timedelta(days=i) for i in range(n)]
    return pd.DataFrame({
        "datetime": timestamps,
        "open": opens,
        "high": high,
        "low": low,
        "close": closes,
    })


@pytest.fixture
def synthetic_hourly() -> pd.DataFrame:
    """200 часовых бар с лёгким восходящим трендом + волатильность ~0.001."""
    rng = np.random.default_rng(seed=43)
    n = 200
    base = np.linspace(1.085, 1.092, n)
    noise = rng.normal(0, 0.0008, n)
    closes = base + noise
    high = closes + np.abs(rng.normal(0, 0.0006, n))
    low = closes - np.abs(rng.normal(0, 0.0006, n))
    opens = closes - rng.normal(0, 0.0004, n)

    start = datetime(2025, 12, 1, tzinfo=timezone.utc)
    timestamps = [start + timedelta(hours=i) for i in range(n)]
    return pd.DataFrame({
        "datetime": timestamps,
        "open": opens,
        "high": high,
        "low": low,
        "close": closes,
    })


@pytest.fixture
def flat_daily() -> pd.DataFrame:
    """260 дневных бар с константным close=1.08 (для тестов на нулевой rate)."""
    n = 260
    close = np.full(n, 1.08)
    start = datetime(2025, 1, 1, tzinfo=timezone.utc)
    timestamps = [start + timedelta(days=i) for i in range(n)]
    return pd.DataFrame({
        "datetime": timestamps,
        "open": close,
        "high": close + 0.0005,
        "low": close - 0.0005,
        "close": close,
    })

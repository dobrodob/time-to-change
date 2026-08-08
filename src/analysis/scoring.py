"""Ансамблевый score 0–100 + классификатор regime.

Логика — пять компонент, каждая в [0, 100], взвешенная сумма даёт итоговый
score. Все функции pure: ввод pd.DataFrame с OHLCV, вывод float либо None
(если данных недостаточно).

Regime classifier — детерминированная функция от score:
    < 65   → "cooldown"
    65–74  → "watch"
    75–84  → "partial"
    ≥ 85   → "strong"

Алерт идёт только при regime ∈ {partial, strong} и при апгрейде regime
(см. src/alerts/gating.py — там это решение).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

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

Regime = Literal["cooldown", "watch", "partial", "strong"]

# Веса компонент. Сумма = 1.0.
WEIGHTS = {
    "trend_daily": 0.25,
    "timing_hourly": 0.25,
    "extremes": 0.20,
    "volatility": 0.10,
    "historical": 0.20,
}


@dataclass(frozen=True)
class ScoreBreakdown:
    """Структурированный результат скоринга — для логов и Telegram-сообщений."""

    score: float
    regime: Regime
    rate: float
    components: dict[str, float | None]  # component_name → [0, 100] или None
    notes: list[str]  # человекочитаемые объяснения для сообщения


def compute_score(daily: pd.DataFrame, hourly: pd.DataFrame) -> ScoreBreakdown:
    """Считает score на основе двух DataFrame'ов.

    Args:
        daily: дневные OHLCV ['open','high','low','close']. Хронологически
            возрастающий, минимум ~200 бар для всех индикаторов.
        hourly: часовые OHLCV. Минимум ~60 бар.

    Returns:
        ScoreBreakdown с итоговым score и regime. Если данных совсем
        мало — score=0, regime="cooldown", notes объяснит причину.
    """
    if daily.empty or hourly.empty:
        return ScoreBreakdown(
            score=0.0,
            regime="cooldown",
            rate=float("nan"),
            components=dict.fromkeys(WEIGHTS),
            notes=["Нет данных для анализа"],
        )

    rate = float(hourly["close"].iloc[-1])

    components: dict[str, float | None] = {
        "trend_daily": _score_trend_daily(daily),
        "timing_hourly": _score_timing_hourly(hourly),
        "extremes": _score_extremes(daily),
        "volatility": _score_volatility(hourly),
        "historical": _score_historical(daily, rate),
    }

    score = _weighted_sum(components)
    regime = classify_regime(score)
    notes = _build_notes(components, rate, daily)

    return ScoreBreakdown(
        score=score,
        regime=regime,
        rate=rate,
        components=components,
        notes=notes,
    )


def classify_regime(score: float, *, watch: float = 65, partial: float = 75, strong: float = 85) -> Regime:
    """Score → regime. Пороги передаются параметрами для тестируемости."""
    if score >= strong:
        return "strong"
    if score >= partial:
        return "partial"
    if score >= watch:
        return "watch"
    return "cooldown"


# Регламент сравнения regime для anti-spam (см. src/alerts/gating.py)
REGIME_ORDER: dict[Regime, int] = {"cooldown": 0, "watch": 1, "partial": 2, "strong": 3}


def regime_rank(regime: Regime | None) -> int:
    if regime is None:
        return 0
    return REGIME_ORDER[regime]


# --- Внутренние функции компонент ---

def _score_trend_daily(daily: pd.DataFrame) -> float | None:
    """EMA20 > EMA50 → 100; иначе 0. +20 если SMA50 > SMA200 (golden cross regime)."""
    close = daily["close"]
    if len(close) < 200:
        # SMA200 не посчитать; деградируем — без бонуса golden cross.
        if len(close) < 50:
            return None
        ema20 = ema(close, 20).iloc[-1]
        ema50 = ema(close, 50).iloc[-1]
        if pd.isna(ema20) or pd.isna(ema50):
            return None
        return 100.0 if ema20 > ema50 else 0.0

    ema20 = ema(close, 20).iloc[-1]
    ema50 = ema(close, 50).iloc[-1]
    sma50 = sma(close, 50).iloc[-1]
    sma200 = sma(close, 200).iloc[-1]
    if any(pd.isna(x) for x in (ema20, ema50, sma50, sma200)):
        return None

    base = 100.0 if ema20 > ema50 else 0.0
    bonus = 20.0 if sma50 > sma200 else 0.0
    return min(100.0, base + bonus)


def _score_timing_hourly(hourly: pd.DataFrame) -> float | None:
    """Часовое подтверждение тренда вверх.

    RSI ∈ (50, 70): линейный ramp 0→100 (т.е. чем ближе к 70, тем лучше).
    RSI > 70: линейный ramp вниз 100→0 при RSI=80 (overbought, импульс на исходе).
    + 20 если MACD histogram > 0 (бычий импульс).
    + 20 если price > EMA20 (выше короткой средней).
    """
    close = hourly["close"]
    if len(close) < 60:
        return None

    rsi_v = rsi(close, 14).iloc[-1]
    macd_v = macd_histogram(close).iloc[-1]
    ema20_v = ema(close, 20).iloc[-1]
    last_close = close.iloc[-1]
    if any(pd.isna(x) for x in (rsi_v, macd_v, ema20_v)):
        return None

    # RSI компонент
    if rsi_v <= 50:
        rsi_score = 0.0
    elif rsi_v <= 70:
        rsi_score = (rsi_v - 50) / 20 * 100.0
    elif rsi_v <= 80:
        rsi_score = (80 - rsi_v) / 10 * 100.0
    else:
        rsi_score = 0.0

    # Cap RSI на 60, чтобы оставить место для MACD/EMA бонусов
    rsi_score = min(60.0, rsi_score)
    macd_bonus = 20.0 if macd_v > 0 else 0.0
    ema_bonus = 20.0 if last_close > ema20_v else 0.0

    return min(100.0, rsi_score + macd_bonus + ema_bonus)


def _score_extremes(daily: pd.DataFrame) -> float | None:
    """«Мы на пике, продавай EUR».

    Дневной RSI > 70 → 100 (overbought, исторически удобный для продавца EUR момент).
    Цена близка к верхней Bollinger band (within 0.3·width) → +30.
    """
    close = daily["close"]
    if len(close) < 30:
        return None

    rsi_v = rsi(close, 14).iloc[-1]
    _lower, middle, upper = bollinger_bands(close, window=20, num_std=2.0)
    upper_v = upper.iloc[-1]
    middle_v = middle.iloc[-1]
    last_close = close.iloc[-1]
    if any(pd.isna(x) for x in (rsi_v, upper_v, middle_v)):
        return None

    # RSI часть
    if rsi_v >= 70:
        rsi_score = 100.0
    elif rsi_v >= 60:
        rsi_score = (rsi_v - 60) / 10 * 100.0
    else:
        rsi_score = 0.0

    # BB часть: дистанция до верхней ленты в долях ширины (upper-middle).
    width = upper_v - middle_v
    bb_bonus = 0.0
    if width > 0:
        gap = upper_v - last_close
        if gap < 0.3 * width:
            bb_bonus = 30.0

    return min(100.0, rsi_score + bb_bonus)


def _score_volatility(hourly: pd.DataFrame) -> float | None:
    """Волатильность не экстремальная.

    Нормализованная ATR (ATR / close) ∈ [0.0008, 0.0025] → 100.
    Выше — линейно к 0 на 0.005.
    Ниже 0.0008 → 50 (подозрительно тихо, неполные данные / выходные).
    """
    if len(hourly) < 30:
        return None

    atr_v = atr(hourly["high"], hourly["low"], hourly["close"], window=14).iloc[-1]
    last_close = hourly["close"].iloc[-1]
    if pd.isna(atr_v) or last_close == 0:
        return None

    norm = atr_v / last_close
    if norm < 0.0008:
        return 50.0
    if norm <= 0.0025:
        return 100.0
    if norm >= 0.005:
        return 0.0
    # 0.0025 → 100, 0.005 → 0, линейно
    return max(0.0, (0.005 - norm) / 0.0025 * 100.0)


def _score_historical(daily: pd.DataFrame, current_rate: float) -> float | None:
    """Перцентиль current_rate среди последних 60 daily closes.

    Окно 60d (раньше было 90d) — быстрее реагирует на regime shifts в
    нестабильной news-driven среде 2025+. Совпадает с TS HISTORICAL_WINDOW_BY_TYPE
    для forex/stock_*/commodity/index (crypto = 45d).
    """
    closes = daily["close"].dropna()
    if len(closes) < 30:
        return None
    sample = closes.tail(60)
    return percentile_rank(sample, current_rate)


def _weighted_sum(components: dict[str, float | None]) -> float:
    """Взвешенная сумма. Компоненты с None → 0 контрибуция (с логом наверху)."""
    total = 0.0
    for name, weight in WEIGHTS.items():
        value = components.get(name)
        if value is None:
            continue
        total += weight * float(value)
    return min(100.0, max(0.0, total))


def _build_notes(components: dict[str, float | None], rate: float, daily: pd.DataFrame) -> list[str]:
    """Человекочитаемые причины сигнала для Telegram-сообщения."""
    notes: list[str] = []

    # historical перцентиль — самая интересная цифра для юзера
    hist = components.get("historical")
    if hist is not None and hist >= 75:
        notes.append(f"курс выше {hist:.0f}% значений за 60 дней")

    # тренд
    trend = components.get("trend_daily")
    if trend is not None and trend >= 100:
        notes.append("дневной тренд за евро (EMA20 > EMA50, golden cross)")
    elif trend is not None and trend > 0:
        notes.append("дневной тренд за евро (EMA20 > EMA50)")

    timing = components.get("timing_hourly")
    if timing is not None and timing >= 60:
        notes.append("часовая картина подтверждает движение вверх")

    extremes = components.get("extremes")
    if extremes is not None and extremes >= 70:
        notes.append("курс у верхней границы (overbought зона)")

    vol = components.get("volatility")
    if vol is not None and vol < 30:
        notes.append("⚠ повышенная волатильность — момент рискованный")

    # Если ничего не сказано — добавим базовое
    if not notes:
        notes.append("технический score основан на 5 компонентах (см. /status)")

    return notes

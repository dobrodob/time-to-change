"""Клиент Twelve Data API (https://api.twelvedata.com).

Минимальный, синхронный (cron-cycle), httpx-based. Возвращает pandas
DataFrame'ы с колонками open/high/low/close (без volume — для FX он
обычно отсутствует или фиктивный).

Учитывает квоту: после каждого запроса смотрит response, не упёрлись ли в
лимит. На 429 — sleeps и retries с backoff.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass

import httpx
import pandas as pd

log = logging.getLogger(__name__)

BASE_URL = "https://api.twelvedata.com"


class TwelveDataError(RuntimeError):
    """API ответил ошибкой (logical: code != 200 in JSON body)."""


class TwelveDataQuotaError(TwelveDataError):
    """Дневной лимит исчерпан."""


@dataclass(frozen=True)
class FetchResult:
    df: pd.DataFrame
    credits_used: int  # сколько кредитов потратил этот запрос


def fetch_time_series(
    *,
    api_key: str,
    symbol: str,
    interval: str,
    outputsize: int,
    timeout: float = 20.0,
    max_retries: int = 3,
) -> FetchResult:
    """Тянет time_series для пары symbol на interval, возвращает DataFrame.

    Args:
        api_key: ключ TWELVEDATA_API_KEY.
        symbol: например 'EUR/USD'.
        interval: '1h' или '1day'.
        outputsize: количество последних бар (макс 5000).

    Returns:
        FetchResult.df с колонками datetime/open/high/low/close (datetime в UTC,
        отсортирован по возрастанию).

    Raises:
        TwelveDataError, TwelveDataQuotaError, httpx.HTTPError.
    """
    url = f"{BASE_URL}/time_series"
    params: dict[str, str] = {
        "symbol": symbol,
        "interval": interval,
        "outputsize": str(outputsize),
        "apikey": api_key,
        "order": "asc",
        "timezone": "UTC",
        "format": "JSON",
    }

    delay = 2.0
    last_exc: Exception | None = None
    for attempt in range(1, max_retries + 1):
        try:
            with httpx.Client(timeout=timeout) as client:
                resp = client.get(url, params=params)

            # Twelve Data на 200 может вернуть error в body — проверяем оба пути
            if resp.status_code == 429:
                raise TwelveDataQuotaError("Rate limit (HTTP 429)")
            resp.raise_for_status()

            payload = resp.json()
            if isinstance(payload, dict) and payload.get("status") == "error":
                code = payload.get("code")
                message = payload.get("message", "unknown error")
                if code in (429, 401, 402):
                    raise TwelveDataQuotaError(f"API quota error {code}: {message}")
                raise TwelveDataError(f"API error {code}: {message}")

            if "values" not in payload:
                raise TwelveDataError(f"Unexpected payload shape: keys={list(payload.keys())}")

            df = _parse_values(payload["values"])
            credits = _credits_from_response(resp, fallback=1)
            return FetchResult(df=df, credits_used=credits)

        except (httpx.TransportError, httpx.HTTPStatusError, TwelveDataError) as exc:
            last_exc = exc
            if isinstance(exc, TwelveDataQuotaError):
                # Не ретраим quota — это явный сигнал остановиться
                raise
            log.warning("Twelve Data attempt %d failed: %s", attempt, exc)
            if attempt < max_retries:
                time.sleep(delay)
                delay *= 2

    assert last_exc is not None
    raise TwelveDataError(f"All {max_retries} attempts failed: {last_exc}") from last_exc


def _parse_values(values: list[dict]) -> pd.DataFrame:
    """Преобразует JSON-массив в DataFrame."""
    df = pd.DataFrame(values)
    if df.empty:
        return df
    df["datetime"] = pd.to_datetime(df["datetime"], utc=True)
    for col in ("open", "high", "low", "close"):
        if col in df.columns:
            df[col] = pd.to_numeric(df[col])
    df = df.sort_values("datetime").reset_index(drop=True)
    return df


def _credits_from_response(resp: httpx.Response, *, fallback: int) -> int:
    """Twelve Data возвращает заголовок 'api-credits-used' или 'X-Api-Credits-Used'.

    Если хедер не нашёлся — fallback (предполагаем 1 кредит на запрос).
    """
    for header_name in ("api-credits-used", "x-api-credits-used"):
        value = resp.headers.get(header_name)
        if value is not None:
            try:
                return int(value)
            except ValueError:
                continue
    return fallback

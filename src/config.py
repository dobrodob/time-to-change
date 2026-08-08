"""Настройки приложения. Все значения читаются из переменных окружения.

Внутри везде UTC. DISPLAY_TIMEZONE влияет только на форматирование времени
в Telegram-сообщениях (см. src/alerts/formatter.py).
"""

from __future__ import annotations

from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # --- Внешние API ---
    twelvedata_api_key: str = Field(default="", alias="TWELVEDATA_API_KEY")
    telegram_bot_token: str = Field(default="", alias="TELEGRAM_BOT_TOKEN")

    # --- Параметры анализа ---
    symbol: str = "EUR/USD"  # формат Twelve Data
    hourly_bars: int = 200
    daily_bars: int = 250

    # --- Гейтинг алертов ---
    # Минимальный edge над rolling 30d median (в процентах) для блокировки алерта.
    # 0 = не блокируем (edge всегда показывается в сообщении, но не фильтрует).
    # Поставь >0 если хочешь жёсткий фильтр (например 0.7 для Wise, 2.5 для банка).
    min_edge_pct: float = Field(default=0.0, alias="MIN_EDGE_PCT")

    # Cooldown: минимум часов между одинаковыми regime alerts.
    cooldown_hours: int = Field(default=24, alias="COOLDOWN_HOURS")

    # Пороги score → regime
    score_watch: float = 65.0
    score_partial: float = 75.0
    score_strong: float = 85.0

    # --- Telegram ---
    display_timezone: str = Field(default="Europe/Madrid", alias="DISPLAY_TIMEZONE")

    # --- Daily digest (время в DISPLAY_TIMEZONE) ---
    digest_hour: int = Field(default=11, alias="DIGEST_HOUR_LOCAL")
    digest_minute: int = Field(default=42, alias="DIGEST_MINUTE_LOCAL")
    digest_tolerance_min: int = Field(default=30, alias="DIGEST_TOLERANCE_MIN")

    # --- Twelve Data quota ---
    twelvedata_credits_daily_cap: int = 800
    twelvedata_credits_warn_at: int = 700

    # --- Пути ---
    repo_root: Path = Field(default_factory=lambda: Path(__file__).resolve().parent.parent)

    @property
    def state_path(self) -> Path:
        return self.repo_root / "state.json"

    @property
    def events_path(self) -> Path:
        return self.repo_root / "data" / "events.json"

    @property
    def cache_dir(self) -> Path:
        return self.repo_root / "data" / "cache"

    @property
    def backtest_dir(self) -> Path:
        return self.repo_root / "data" / "backtest"


def get_settings() -> Settings:
    """Возвращает настройки. Не кэшируем — тесты должны мочь подменять env."""
    return Settings()

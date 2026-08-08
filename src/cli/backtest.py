"""Запуск бэктеста локально или через workflow_dispatch.

Usage:
    python -m src.cli.backtest --months 12

Тянет hourly+daily из Twelve Data (с кэшем в data/cache/), прогоняет
правила, выкладывает отчёт в data/backtest/.
"""

from __future__ import annotations

import argparse
import logging
import math
import sys

from src.backtest.engine import run_backtest
from src.backtest.report import write_report
from src.config import get_settings
from src.data import twelvedata_client

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s | %(message)s")
log = logging.getLogger("backtest")


def _bounded_int(value: str, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("must be an integer") from exc
    if not minimum <= parsed <= maximum:
        raise argparse.ArgumentTypeError(f"must be between {minimum} and {maximum}")
    return parsed


def _bounded_float(value: str, minimum: float, maximum: float) -> float:
    try:
        parsed = float(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("must be a number") from exc
    if not math.isfinite(parsed) or not minimum <= parsed <= maximum:
        raise argparse.ArgumentTypeError(f"must be between {minimum:g} and {maximum:g}")
    return parsed


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="EUR/USD walk-forward backtest")
    parser.add_argument(
        "--months",
        type=lambda value: _bounded_int(value, 1, 12),
        default=12,
        help="мес часовой истории (1-12)",
    )
    parser.add_argument(
        "--starting-eur",
        type=lambda value: _bounded_float(value, 0.01, 1_000_000_000),
        default=1000.0,
    )
    parser.add_argument(
        "--min-edge-pct",
        type=lambda value: _bounded_float(value, -100, 100),
        default=None,
        help="override settings",
    )
    return parser


def main() -> int:
    args = build_parser().parse_args()

    settings = get_settings()
    if not settings.twelvedata_api_key:
        log.error("TWELVEDATA_API_KEY не задан")
        return 1

    hourly_size = min(5000, args.months * 30 * 24)
    daily_size = min(5000, max(250, 90 * 12))

    log.info("Fetching hourly outputsize=%d, daily outputsize=%d", hourly_size, daily_size)
    daily = twelvedata_client.fetch_time_series(
        api_key=settings.twelvedata_api_key,
        symbol=settings.symbol,
        interval="1day",
        outputsize=daily_size,
    ).df
    hourly = twelvedata_client.fetch_time_series(
        api_key=settings.twelvedata_api_key,
        symbol=settings.symbol,
        interval="1h",
        outputsize=hourly_size,
    ).df
    log.info("Got daily=%d rows, hourly=%d rows", len(daily), len(hourly))

    min_edge = args.min_edge_pct if args.min_edge_pct is not None else settings.min_edge_pct
    result = run_backtest(
        daily,
        hourly,
        starting_eur=args.starting_eur,
        min_edge_pct=min_edge,
        cooldown_hours=settings.cooldown_hours,
    )

    csv_path, md_path = write_report(result, settings.backtest_dir)
    log.info("Отчёт: %s", md_path)
    log.info("Тиков: %s", csv_path)

    print()
    print(f"Strategy total USD: {result.strategy_total_usd:.2f}")
    print(f"Baseline total USD: {result.baseline_total_usd:.2f}")
    print(f"Alpha:              {result.strategy_total_usd - result.baseline_total_usd:+.2f}")
    print(f"Alerts:             {result.alerts_count}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

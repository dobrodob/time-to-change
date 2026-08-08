#!/usr/bin/env python3
"""Generate Python→TS parity fixtures.

Импортирует production Python функции (parse_command, classify_regime,
compute_edge_pct, percentile_rank, ema, rsi) и сериализует
(input, expected_output) cases в JSON, который потом читают TS-тесты
для idempotent verification после порта.

Usage:
    python tools/scripts/gen_parity_fixtures.py [--out worker/tests/parity/fixtures]

Запускается ДО port-задач (A.8 parser, A.10-A.12 math). См. план §A.7b.
"""
from __future__ import annotations

import argparse
import json
from dataclasses import asdict, is_dataclass
from datetime import timedelta
from pathlib import Path

import numpy as np
import pandas as pd

from src.alerts.gating import compute_edge_pct
from src.analysis.indicators import ema, percentile_rank, rsi
from src.analysis.scoring import classify_regime, compute_score
from src.telegram_io.commands import parse_callback, parse_command


def _to_jsonable(value):
    """Recursively convert ParsedCommand / timedelta / dataclass / etc to JSON-friendly."""
    if value is None or isinstance(value, (str, int, bool, float)):
        return value
    if isinstance(value, timedelta):
        return {"__type__": "timedelta", "total_seconds": value.total_seconds()}
    if is_dataclass(value):
        return {k: _to_jsonable(v) for k, v in asdict(value).items()}
    if isinstance(value, (list, tuple)):
        return [_to_jsonable(v) for v in value]
    if isinstance(value, dict):
        return {k: _to_jsonable(v) for k, v in value.items()}
    raise TypeError(f"Cannot serialize {type(value)}: {value!r}")


# ============ parse_command ============

PARSE_COMMAND_INPUTS = [
    "/start",
    "/help",
    "/status",
    "/explain",
    "/resume",
    "/whoami",
    "/users",
    "/leave",
    "/silence",
    "/silence 7d",
    "/silence 3h",
    "/silence 2w",
    "/silence 40d",  # > MAX, должно clamp до 30d
    "/silence invalid",
    "/invite 12345",
    "/invite abc",  # invalid
    "/invite -100200300",
    "/budget",
    "/budget 6000 30d",
    "/budget 6000 30",
    "/budget done 1500 1.0852",
    "/budget done 500",
    "/budget cancel",
    "/budget off",
    "/quiet",
    "/quiet 23 7",
    "/quiet 0 0",
    "/quiet off",
    "/quiet show",
    "/digest",
    "/digest on",
    "/digest off",
    "/something_unknown",
    "not a command at all",
    "",
    "/start@SomeBotName",  # /command@bot suffix должен strip'аться
    "  /status  ",  # whitespace
]


def gen_parser_commands():
    cases = []
    for text in PARSE_COMMAND_INPUTS:
        parsed = parse_command(text)
        cases.append({"input": text, "expected": _to_jsonable(parsed)})
    return cases


# ============ parse_callback ============

PARSE_CALLBACK_INPUTS = [
    "b:done:30",
    "b:done:50",
    "b:done:100",
    "b:done:0",  # invalid (>0 required)
    "b:done:150",  # invalid (>100)
    "b:sil:1d",
    "b:sil:7d",
    "b:sil:3h",
    "b:sil:40d",  # > MAX_SILENCE 30d
    "b:sil:bad",
    "b:done",  # missing arg
    "b:unknown:x",
    "x:done:30",  # wrong prefix
    "garbage",
    "",
]


def gen_parser_callbacks():
    cases = []
    for data in PARSE_CALLBACK_INPUTS:
        parsed = parse_callback(data)
        cases.append({"input": data, "expected": _to_jsonable(parsed)})
    return cases


# ============ classify_regime ============

CLASSIFY_REGIME_INPUTS = [40, 50, 60, 65, 70, 74.99, 75, 80, 84.99, 85, 90, 100, 0, -10]


def gen_classify_regime():
    cases = []
    for score in CLASSIFY_REGIME_INPUTS:
        regime = classify_regime(score)
        cases.append({"input": {"score": score}, "expected": regime})
    return cases


# ============ compute_edge_pct ============

EDGE_INPUTS = [
    (1.18, 1.17),
    (1.17, 1.17),
    (1.10, 1.17),
    (1.18, None),  # baseline None
    (1.0, 0.9),
    (0.9, 1.0),
    (1.18, 0.0),  # zero baseline → safe fallback
]


def gen_compute_edge_pct():
    cases = []
    for rate, baseline in EDGE_INPUTS:
        edge = compute_edge_pct(rate, baseline)
        cases.append({"input": {"rate": rate, "baseline_median_30d": baseline}, "expected": edge})
    return cases


# ============ percentile_rank ============

def gen_percentile_rank():
    cases = []
    samples = [
        ([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5.0),
        ([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 10.5),  # > all
        ([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5),  # < all
        ([1.0, 1.0, 1.0, 1.0], 1.0),  # all equal
        (list(range(100)), 50.0),
    ]
    for arr, val in samples:
        series = pd.Series(arr, dtype=float)
        rank = percentile_rank(series, val)
        cases.append({"input": {"values": arr, "target": val}, "expected": rank})
    return cases


# ============ ema ============

def _nan_to_none(arr):
    """Конвертирует NaN → None в массиве для JSON-validity."""
    return [None if pd.isna(v) else float(v) for v in arr]


def gen_ema():
    cases = []
    # Каждый case: (input array, window, expected output array)
    inputs = [
        ([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20], 5),
        ([1.0, 2.0, 3.0, 4.0, 5.0], 3),
        ([100, 100, 100, 100, 100], 5),  # constant
        ([1, 2, 1, 2, 1, 2, 1, 2], 4),  # oscillating
    ]
    for arr, window in inputs:
        series = pd.Series(arr, dtype=float)
        result = ema(series, window)
        cases.append(
            {
                "input": {"values": [float(x) for x in arr], "window": window},
                "expected": _nan_to_none(result.tolist()),
            }
        )
    return cases


# ============ rsi ============

def gen_rsi():
    cases = []
    inputs = [
        # Длинный uptrend
        ([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25], 14),
        # Длинный downtrend
        ([25, 24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10], 14),
        # Mixed
        ([10, 12, 11, 13, 12, 14, 13, 15, 14, 16, 15, 17, 16, 18, 17, 19], 14),
    ]
    for arr, window in inputs:
        series = pd.Series(arr, dtype=float)
        result = rsi(series, window)
        cases.append(
            {
                "input": {"values": [float(x) for x in arr], "window": window},
                "expected": _nan_to_none(result.tolist()),
            }
        )
    return cases


# ============ compute_score (full ensemble) ============


def _make_candles(n: int, seed: int, base: float = 1.18) -> pd.DataFrame:
    """Deterministic synthetic OHLC for parity testing."""
    rng = np.random.default_rng(seed)
    # Random walk closes
    deltas = rng.normal(0, 0.001, n)
    closes = base + np.cumsum(deltas)
    opens = closes - rng.normal(0, 0.0005, n)
    highs = np.maximum(opens, closes) + np.abs(rng.normal(0, 0.0003, n))
    lows = np.minimum(opens, closes) - np.abs(rng.normal(0, 0.0003, n))
    return pd.DataFrame(
        {
            "open": opens,
            "high": highs,
            "low": lows,
            "close": closes,
        }
    )


def gen_compute_score():
    """Generates 5 (daily_ohlc, hourly_ohlc) cases с детерминистичной random-walk
    цепочкой свечей. Закрывает full ensemble path (5 components + weighted sum +
    classify_regime + notes generation).
    """
    cases = []
    for seed in [1, 42, 100, 2024, 7]:
        daily_df = _make_candles(200, seed, base=1.18)
        hourly_df = _make_candles(200, seed + 1000, base=float(daily_df["close"].iloc[-1]))
        breakdown = compute_score(daily_df, hourly_df)
        cases.append(
            {
                "input": {
                    # [[open, high, low, close], ...] — TS воссоздаст Candle[]
                    "daily": [
                        [float(r[0]), float(r[1]), float(r[2]), float(r[3])]
                        for r in daily_df.values.tolist()
                    ],
                    "hourly": [
                        [float(r[0]), float(r[1]), float(r[2]), float(r[3])]
                        for r in hourly_df.values.tolist()
                    ],
                },
                "expected": {
                    "score": float(breakdown.score),
                    "regime": breakdown.regime,
                    "rate": float(breakdown.rate),
                    "components": {
                        k: (None if v is None else float(v))
                        for k, v in breakdown.components.items()
                    },
                    "notes": list(breakdown.notes),
                },
            }
        )
    return cases


# ============ Main ============

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--out",
        default="worker/tests/parity/fixtures",
        help="Output directory for fixture JSON files",
    )
    args = ap.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    suites = {
        "parser-commands.json": gen_parser_commands,
        "parser-callbacks.json": gen_parser_callbacks,
        "classify-regime.json": gen_classify_regime,
        "compute-edge-pct.json": gen_compute_edge_pct,
        "percentile-rank.json": gen_percentile_rank,
        "ema.json": gen_ema,
        "rsi.json": gen_rsi,
        "compute-score.json": gen_compute_score,
    }

    total_cases = 0
    for filename, generator in suites.items():
        cases = generator()
        with open(out_dir / filename, "w", encoding="utf-8") as f:
            # allow_nan=False — fail-fast если NaN протекли в выход.
            # Все None должны быть из _nan_to_none().
            json.dump(cases, f, indent=2, ensure_ascii=False, allow_nan=False)
        print(f"  {filename}: {len(cases)} cases")
        total_cases += len(cases)

    print(f"\nGenerated {total_cases} fixture cases across {len(suites)} files in {out_dir}/")


if __name__ == "__main__":
    main()

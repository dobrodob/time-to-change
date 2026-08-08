"""Отчёт по результатам бэктеста: CSV (все тики) + markdown (summary)."""

from __future__ import annotations

import csv
from pathlib import Path

from src.backtest.engine import BacktestResult


def write_report(result: BacktestResult, out_dir: Path) -> tuple[Path, Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    csv_path = out_dir / "runs.csv"
    md_path = out_dir / "report.md"

    # CSV
    with csv_path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow(["ts", "rate", "score", "regime", "edge_pct", "alerted", "converted_eur", "received_usd"])
        for t in result.ticks:
            writer.writerow([
                t.ts.isoformat(),
                f"{t.rate:.6f}",
                f"{t.score:.2f}",
                t.regime,
                f"{t.edge_pct:.4f}",
                int(t.alerted),
                f"{t.converted_eur:.4f}",
                f"{t.received_usd:.4f}",
            ])

    # Markdown summary
    strategy = result.strategy_total_usd
    baseline = result.baseline_total_usd
    alpha_usd = strategy - baseline
    alpha_pct = (alpha_usd / baseline * 100.0) if baseline > 0 else 0.0

    partial_alerts = [t for t in result.ticks if t.alerted and t.regime == "partial"]
    strong_alerts = [t for t in result.ticks if t.alerted and t.regime == "strong"]

    md = [
        "# EUR/USD Backtest Report",
        "",
        f"- Стартовая сумма: **{result.starting_eur:.0f} EUR**",
        f"- Тиков всего: **{len(result.ticks)}**",
        f"- Алертов: **{result.alerts_count}** (partial={len(partial_alerts)}, strong={len(strong_alerts)})",
        f"- Средний rate в алертах: **{result.avg_alert_rate:.5f}**" if result.alerts_count else "- Алертов не было",
        "",
        "## Итоги",
        "",
        f"- Strategy (alert-driven): **{strategy:.2f} USD**",
        f"- Baseline (weekly Fridays): **{baseline:.2f} USD**",
        f"- Alpha: **{alpha_usd:+.2f} USD** ({alpha_pct:+.2f}%)",
        "",
    ]

    if result.alerts_count:
        md.append("## Алерты по убыванию rate")
        md.append("")
        md.append("| ts (UTC) | regime | rate | score | edge_pct |")
        md.append("|---|---|---|---|---|")
        sorted_alerts = sorted(
            [t for t in result.ticks if t.alerted],
            key=lambda x: -x.rate,
        )
        for t in sorted_alerts[:20]:
            md.append(
                f"| {t.ts.strftime('%Y-%m-%d %H:%M')} | {t.regime} | "
                f"{t.rate:.5f} | {t.score:.1f} | {t.edge_pct:+.2f}% |"
            )

    md_path.write_text("\n".join(md) + "\n", encoding="utf-8")
    return csv_path, md_path

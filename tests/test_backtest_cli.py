import pytest

from src.cli.backtest import build_parser


def test_backtest_parser_accepts_bounded_inputs() -> None:
    args = build_parser().parse_args(
        ["--months", "6", "--starting-eur", "2500", "--min-edge-pct", "2.5"]
    )
    assert args.months == 6
    assert args.starting_eur == 2500
    assert args.min_edge_pct == 2.5


@pytest.mark.parametrize(
    ("flag", "value"),
    [
        ("--months", "0"),
        ("--months", "13"),
        ("--starting-eur", "0"),
        ("--starting-eur", "nan"),
        ("--min-edge-pct", "inf"),
        ("--min-edge-pct", "101"),
    ],
)
def test_backtest_parser_rejects_out_of_range_inputs(flag: str, value: str) -> None:
    with pytest.raises(SystemExit):
        build_parser().parse_args([flag, value])

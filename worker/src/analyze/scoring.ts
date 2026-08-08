/**
 * Ансамблевый скоринг 0-100. Port of src/analysis/scoring.py.
 *
 * 5 компонент:
 *   trend_daily   — EMA20 vs EMA50 + golden cross bonus
 *   timing_hourly — RSI/MACD/EMA20 на часовом
 *   extremes      — overbought signal (daily RSI + Bollinger)
 *   volatility    — нормализованная ATR (direction-agnostic)
 *   historical    — percentile rank в окне N дней
 *
 * Веса и окно historical — **per asset type** (см. WEIGHTS_BY_TYPE и
 * HISTORICAL_WINDOW_BY_TYPE). Forex/commodity сохраняют исторические дефолты
 * 0.25/0.25/0.20/0.10/0.20 + window 90 (валидировано baseline-backtest'ом).
 * Stocks/crypto/index получают свой профиль исходя из природы рынка.
 *
 * Compute_score parity tested via runtime сравнение (handcrafted candles);
 * classify_regime parity verified через fixtures.
 */
import type { AssetType, Direction } from "../state/schema";
import { atr, bollingerBands, ema, macdHistogram, percentileRank, rsi, sma } from "./indicators";

export type Regime = "cooldown" | "watch" | "partial" | "strong";
export type { Direction } from "../state/schema";

/**
 * Per-asset-type веса 5 компонент. Сумма каждой row = 1.0.
 *
 * Рассуждение по типам:
 * - **forex**: классика 0.25/0.25 — trend и timing равноценны для FX. Window
 *   60d (раньше 90d) — news-driven нестабильность 2025+: ЦБ, sanctions, торговые
 *   войны. Backtest на 12 мес EUR/USD: +39% relative alpha vs 90d.
 * - **stock_us**: timing 0.30 vs trend 0.20 — quarterly earnings cycles делают
 *   intraday RSI/MACD более информативными чем дневная EMA50. Window 60d
 *   быстрее реагирует на post-earnings regime shifts.
 * - **stock_ru**: timing 0.30 vs trend 0.20 — унифицирован с stock_us. RU-акции
 *   быстро реагируют на news (sanctions, ЦБ, нефть, политика) — hourly RSI/MACD
 *   ловит это first; дивидендные отсечки искажают дневной тренд. Window 60d
 *   (унифицированно с stock_us).
 * - **commodity**: как forex (золото/серебро ведут себя как валюты с
 *   разрядкой через USD index).
 * - **crypto**: timing 0.35 — 24/7 рынок, intraday momentum критичнее. Window
 *   45d — короче cycles (no traditional business calendar). Trend 0.15 —
 *   не overweight, иначе HODL bias.
 * - **index**: trend 0.30 — индекс по определению следует общему тренду
 *   рынка, частная intraday-волатильность отдельных бумаг усредняется.
 */
export const WEIGHTS_BY_TYPE: Record<AssetType, Record<string, number>> = {
  forex: {
    trend_daily: 0.25,
    timing_hourly: 0.25,
    extremes: 0.2,
    volatility: 0.1,
    historical: 0.2,
  },
  stock_us: {
    trend_daily: 0.2,
    timing_hourly: 0.3,
    extremes: 0.2,
    volatility: 0.1,
    historical: 0.2,
  },
  // stock_ru — унифицирован с stock_us (timing > trend). Reasoning:
  // RU-акции быстро реагируют на news (sanctions, ставка ЦБ, нефть, политика),
  // hourly RSI/MACD ловит это first; дивидендные отсечки и одно-дневные события
  // искажают дневной тренд. Также single mental model — один профиль для всех
  // акций.
  //
  // EXPERIMENTAL: всё ещё без backtest validation на MOEX. Когда появится
  // исторический dataset + backtest tool для не-forex — валидировать (или
  // разойтись с stock_us если данные покажут).
  stock_ru: {
    trend_daily: 0.2,
    timing_hourly: 0.3,
    extremes: 0.2,
    volatility: 0.1,
    historical: 0.2,
  },
  commodity: {
    trend_daily: 0.25,
    timing_hourly: 0.25,
    extremes: 0.2,
    volatility: 0.1,
    historical: 0.2,
  },
  crypto: {
    trend_daily: 0.15,
    timing_hourly: 0.35,
    extremes: 0.2,
    volatility: 0.1,
    historical: 0.2,
  },
  index: { trend_daily: 0.3, timing_hourly: 0.2, extremes: 0.2, volatility: 0.1, historical: 0.2 },
};

/**
 * Окно historical percentile_rank — per asset type.
 *
 * 60d для всех major asset classes (forex / stocks / commodity / index) — после
 * наблюдения трейдеров что в 2025+ news-driven нестабильный рынок: 60d быстрее
 * реагирует на regime shifts (центробанки, sanctions, oil, политика, earnings).
 * Forex backtest на 12 мес EUR/USD подтвердил: 60d даёт +39% relative alpha vs
 * 90d (1 → 2 alerts caught на pikах).
 *
 * Crypto: 45d (ещё короче natural cycles, 24/7 рынок без business calendar).
 */
export const HISTORICAL_WINDOW_BY_TYPE: Record<AssetType, number> = {
  forex: 60,
  stock_us: 60,
  stock_ru: 60,
  commodity: 60,
  crypto: 45,
  index: 60,
};

/** Legacy export — forex weights. Сохранён для обратной совместимости. */
export const WEIGHTS: Record<string, number> = WEIGHTS_BY_TYPE.forex;

/**
 * Helper: веса для type. По дефолту forex (для callsites без assetType).
 * Кидает Error если type не из enum — fail-loud при schema drift (например
 * если в AssetType добавили новый вариант но забыли обновить WEIGHTS_BY_TYPE).
 */
export function weightsFor(assetType: AssetType | undefined): Record<string, number> {
  const type = assetType ?? "forex";
  const weights = WEIGHTS_BY_TYPE[type];
  if (weights === undefined) {
    throw new Error(
      `weightsFor: неизвестный AssetType "${type}". WEIGHTS_BY_TYPE расходится с enum AssetType.`,
    );
  }
  return weights;
}

/**
 * Helper: окно historical percentile для type. По дефолту 90.
 * Аналогично weightsFor — fail-loud на unknown type.
 */
export function historicalWindowFor(assetType: AssetType | undefined): number {
  const type = assetType ?? "forex";
  const window = HISTORICAL_WINDOW_BY_TYPE[type];
  if (window === undefined) {
    throw new Error(
      `historicalWindowFor: неизвестный AssetType "${type}". HISTORICAL_WINDOW_BY_TYPE расходится с enum AssetType.`,
    );
  }
  return window;
}

const REGIME_ORDER: Record<Regime, number> = {
  cooldown: 0,
  watch: 1,
  partial: 2,
  strong: 3,
};

export function regimeRank(regime: Regime | null): number {
  if (regime === null) return 0;
  return REGIME_ORDER[regime];
}

export interface Candle {
  datetime: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface ScoreBreakdown {
  score: number;
  regime: Regime;
  rate: number;
  components: Record<string, number | null>;
  notes: string[];
}

/**
 * Score → regime. Пороги — параметры для тестируемости.
 * Port src/analysis/scoring.py:classify_regime.
 */
export function classifyRegime(score: number, watch = 65, partial = 75, strong = 85): Regime {
  if (score >= strong) return "strong";
  if (score >= partial) return "partial";
  if (score >= watch) return "watch";
  return "cooldown";
}

/**
 * Considers full ensemble для конкретного direction и assetType.
 *
 * direction="sell" (default — backward compat): high price + high RSI + high
 *   percentile = выгодно продавать. Используется для EUR/USD (продать EUR).
 *
 * direction="buy": low price + low RSI + low percentile = выгодно покупать.
 *   Используется для stocks (AAPL ниже за 90 дней = выгодно купить).
 *
 * assetType="forex" (default — backward compat): per-type веса и окно historical
 *   через weightsFor/historicalWindowFor. Forex даёт legacy поведение
 *   (0.25/0.25/0.20/0.10/0.20 + window 90).
 *
 * Каждый component direction-aware; volatility direction-agnostic (низкая
 * vol хороша для обоих).
 */
export function computeScore(
  daily: Candle[],
  hourly: Candle[],
  direction: Direction = "sell",
  assetType: AssetType = "forex",
): ScoreBreakdown {
  if (daily.length === 0 || hourly.length === 0) {
    return {
      score: 0,
      regime: "cooldown",
      rate: Number.NaN,
      components: {
        trend_daily: null,
        timing_hourly: null,
        extremes: null,
        volatility: null,
        historical: null,
      },
      notes: ["Нет данных для анализа"],
    };
  }

  const weights = weightsFor(assetType);
  const historicalWindow = historicalWindowFor(assetType);
  const rate = hourly[hourly.length - 1].close;
  const components: Record<string, number | null> = {
    trend_daily: scoreTrendDaily(daily, direction),
    timing_hourly: scoreTimingHourly(hourly, direction),
    extremes: scoreExtremes(daily, direction),
    volatility: scoreVolatility(hourly),
    historical: scoreHistorical(daily, rate, direction, historicalWindow),
  };
  const score = weightedSum(components, weights);
  const regime = classifyRegime(score);
  const notes = buildNotes(components, direction, historicalWindow);
  return { score, regime, rate, components, notes };
}

function closes(candles: Candle[]): number[] {
  return candles.map((c) => c.close);
}

function highs(candles: Candle[]): number[] {
  return candles.map((c) => c.high);
}

function lows(candles: Candle[]): number[] {
  return candles.map((c) => c.low);
}

function lastValid(arr: number[]): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (!Number.isNaN(arr[i])) return arr[i];
  }
  return Number.NaN;
}

function scoreTrendDaily(daily: Candle[], direction: Direction): number | null {
  const close = closes(daily);
  if (close.length < 50) return null;
  const ema20 = ema(close, 20).at(-1);
  const ema50 = ema(close, 50).at(-1);
  if (ema20 === undefined || ema50 === undefined || Number.isNaN(ema20) || Number.isNaN(ema50)) {
    return null;
  }
  // sell: uptrend = выгодно продать. buy: downtrend = выгодно купить.
  const trendIsGood = direction === "sell" ? ema20 > ema50 : ema20 < ema50;
  if (close.length < 200) {
    return trendIsGood ? 100 : 0;
  }
  const sma50 = sma(close, 50).at(-1);
  const sma200 = sma(close, 200).at(-1);
  if (sma50 === undefined || sma200 === undefined || Number.isNaN(sma50) || Number.isNaN(sma200)) {
    return null;
  }
  const base = trendIsGood ? 100 : 0;
  // golden cross (sma50>sma200) bonus для sell, death cross для buy
  const longTrendGood = direction === "sell" ? sma50 > sma200 : sma50 < sma200;
  const bonus = longTrendGood ? 20 : 0;
  return Math.min(100, base + bonus);
}

function scoreTimingHourly(hourly: Candle[], direction: Direction): number | null {
  const close = closes(hourly);
  if (close.length < 60) return null;
  const rsiV = rsi(close, 14).at(-1);
  const macdV = macdHistogram(close).at(-1);
  const ema20V = ema(close, 20).at(-1);
  const lastClose = close.at(-1);
  if (
    rsiV === undefined ||
    macdV === undefined ||
    ema20V === undefined ||
    lastClose === undefined ||
    Number.isNaN(rsiV) ||
    Number.isNaN(macdV) ||
    Number.isNaN(ema20V)
  ) {
    return null;
  }
  let rsiScore: number;
  if (direction === "sell") {
    // RSI ramp 50→70 (good), 70→80 (waning), <50 or >80 = 0.
    if (rsiV <= 50) rsiScore = 0;
    else if (rsiV <= 70) rsiScore = ((rsiV - 50) / 20) * 100;
    else if (rsiV <= 80) rsiScore = ((80 - rsiV) / 10) * 100;
    else rsiScore = 0;
  } else {
    // buy: mirror — RSI ramp 50→30 (good), 30→20 (waning), >50 or <20 = 0.
    if (rsiV >= 50) rsiScore = 0;
    else if (rsiV >= 30) rsiScore = ((50 - rsiV) / 20) * 100;
    else if (rsiV >= 20) rsiScore = ((rsiV - 20) / 10) * 100;
    else rsiScore = 0;
  }
  rsiScore = Math.min(60, rsiScore);
  // MACD>0 = bullish (sell good); MACD<0 = bearish (buy good)
  const macdGood = direction === "sell" ? macdV > 0 : macdV < 0;
  const macdBonus = macdGood ? 20 : 0;
  // price>ema20 = uptrend (sell good); price<ema20 = downtrend (buy good)
  const emaGood = direction === "sell" ? lastClose > ema20V : lastClose < ema20V;
  const emaBonus = emaGood ? 20 : 0;
  return Math.min(100, rsiScore + macdBonus + emaBonus);
}

function scoreExtremes(daily: Candle[], direction: Direction): number | null {
  const close = closes(daily);
  if (close.length < 30) return null;
  const rsiV = rsi(close, 14).at(-1);
  const bb = bollingerBands(close, 20, 2);
  const upperV = bb.upper.at(-1);
  const lowerV = bb.lower.at(-1);
  const middleV = bb.middle.at(-1);
  const lastClose = close.at(-1);
  if (
    rsiV === undefined ||
    upperV === undefined ||
    lowerV === undefined ||
    middleV === undefined ||
    lastClose === undefined ||
    Number.isNaN(rsiV) ||
    Number.isNaN(upperV) ||
    Number.isNaN(lowerV) ||
    Number.isNaN(middleV)
  ) {
    return null;
  }
  let rsiScore: number;
  if (direction === "sell") {
    // High RSI = overbought = sell signal.
    if (rsiV >= 70) rsiScore = 100;
    else if (rsiV >= 60) rsiScore = ((rsiV - 60) / 10) * 100;
    else rsiScore = 0;
  } else {
    // buy: Low RSI = oversold = buy signal.
    if (rsiV <= 30) rsiScore = 100;
    else if (rsiV <= 40) rsiScore = ((40 - rsiV) / 10) * 100;
    else rsiScore = 0;
  }
  const width = upperV - middleV;
  let bbBonus = 0;
  if (width > 0) {
    if (direction === "sell") {
      const gap = upperV - lastClose;
      if (gap < 0.3 * width) bbBonus = 30;
    } else {
      const gap = lastClose - lowerV;
      if (gap < 0.3 * width) bbBonus = 30;
    }
  }
  return Math.min(100, rsiScore + bbBonus);
}

function scoreVolatility(hourly: Candle[]): number | null {
  if (hourly.length < 30) return null;
  const atrSeries = atr(highs(hourly), lows(hourly), closes(hourly), 14);
  const atrV = lastValid(atrSeries);
  const lastClose = closes(hourly).at(-1);
  if (lastClose === undefined || Number.isNaN(atrV) || lastClose === 0) return null;
  const norm = atrV / lastClose;
  if (norm < 0.0008) return 50;
  if (norm <= 0.0025) return 100;
  if (norm >= 0.005) return 0;
  return Math.max(0, ((0.005 - norm) / 0.0025) * 100);
}

function scoreHistorical(
  daily: Candle[],
  currentRate: number,
  direction: Direction,
  window: number,
): number | null {
  const close = closes(daily).filter((v) => !Number.isNaN(v));
  if (close.length < 30) return null;
  const sample = close.slice(-window);
  const rank = percentileRank(sample, currentRate);
  // sell: high percentile = выгодно продать (high price). buy: invert.
  return direction === "sell" ? rank : 100 - rank;
}

function weightedSum(
  components: Record<string, number | null>,
  weights: Record<string, number>,
): number {
  let total = 0;
  for (const [name, weight] of Object.entries(weights)) {
    const v = components[name];
    if (v === null || v === undefined) continue;
    total += weight * v;
  }
  return Math.min(100, Math.max(0, total));
}

function buildNotes(
  components: Record<string, number | null>,
  direction: Direction,
  historicalWindow: number,
): string[] {
  // Естественный язык, direction-aware. Каждая фраза независима — user видит
  // N подтверждений из 5 возможных.
  const notes: string[] = [];
  const verb = direction === "sell" ? "продать" : "купить";
  const peakOrBottom = direction === "sell" ? "пику" : "дну";

  const hist = components.historical;
  if (hist !== null && hist !== undefined && hist >= 75) {
    const pct = Math.round(hist);
    if (direction === "sell") {
      notes.push(
        `цена выше ${pct}% значений за ${historicalWindow} дней — близко к ${peakOrBottom}`,
      );
    } else {
      notes.push(
        `цена ниже ${pct}% значений за ${historicalWindow} дней — близко к ${peakOrBottom}`,
      );
    }
  }

  const trend = components.trend_daily;
  if (trend !== null && trend !== undefined) {
    if (direction === "sell") {
      if (trend >= 100) notes.push("устойчивый аптренд (golden cross)");
      else if (trend > 0) notes.push("аптренд на дневном масштабе");
    } else {
      if (trend >= 100) notes.push("устойчивый даунтренд (death cross)");
      else if (trend > 0) notes.push("даунтренд на дневном масштабе");
    }
  }

  const timing = components.timing_hourly;
  if (timing !== null && timing !== undefined && timing >= 60) {
    notes.push("момент подкреплён часовой динамикой");
  }

  const extremes = components.extremes;
  if (extremes !== null && extremes !== undefined && extremes >= 70) {
    if (direction === "sell") {
      notes.push(`перекупленность — типично хороший момент ${verb}`);
    } else {
      notes.push(`перепроданность — типично хороший момент ${verb}`);
    }
  }

  const vol = components.volatility;
  if (vol !== null && vol !== undefined && vol < 30) {
    notes.push("⚠ повышенная волатильность — момент рискованный");
  }

  if (notes.length === 0) {
    notes.push("score основан на 5 компонентах — детали через /explain");
  }
  return notes;
}

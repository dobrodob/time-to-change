/**
 * Технические индикаторы. Pure-функции на массивах чисел.
 *
 * Port of src/analysis/indicators.py. Все функции возвращают массив той же
 * длины что вход; NaN-входы → NaN-выходы. Где Python давал NaN в первых
 * window барах — в TS используем `null` (более явное).
 *
 * Parity verified via tests/parity/indicators.test.ts.
 */

/**
 * Exponential Moving Average. Стандартная формула: alpha = 2 / (window + 1),
 * seed = первая полная скользящая средняя (SMA первых `window` значений),
 * чтобы соответствовать pandas `.ewm(span=window, adjust=False, min_periods=window)`.
 *
 * Возвращает массив длины как у входа. Первые `window-1` значения = NaN
 * (недостаточно данных).
 */
export function ema(values: number[], window: number): number[] {
  if (window <= 0) throw new Error("ema: window must be > 0");
  const n = values.length;
  const out: number[] = new Array(n).fill(Number.NaN);
  if (n < window) return out;

  const alpha = 2 / (window + 1);
  // pandas .ewm(adjust=False, min_periods=window).mean():
  // - Skips leading NaN to find seed (first non-NaN value).
  // - For subsequent NaN positions, doesn't update prev, doesn't count toward
  //   min_periods. y[i] = NaN at NaN positions (но prev сохраняется).
  // - First valid output when window non-NaN observations have been seen.
  // Этот behavior критичен для chained индикаторов (MACD histogram = signal(macd)
  // где macd имеет N NaN в начале) — без skip seed early ema=NaN forever.
  let seedIdx = -1;
  for (let i = 0; i < n; i++) {
    if (!Number.isNaN(values[i])) {
      seedIdx = i;
      break;
    }
  }
  if (seedIdx === -1) return out; // all NaN

  let prev = values[seedIdx];
  let nonNanCount = 1;
  if (nonNanCount >= window) {
    out[seedIdx] = prev;
  }
  for (let i = seedIdx + 1; i < n; i++) {
    if (Number.isNaN(values[i])) continue;
    prev = alpha * values[i] + (1 - alpha) * prev;
    nonNanCount++;
    if (nonNanCount >= window) {
      out[i] = prev;
    }
  }
  return out;
}

/**
 * Simple Moving Average. Возвращает массив той же длины; первые `window-1` = NaN.
 */
export function sma(values: number[], window: number): number[] {
  if (window <= 0) throw new Error("sma: window must be > 0");
  const n = values.length;
  const out: number[] = new Array(n).fill(Number.NaN);
  if (n < window) return out;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += values[i];
    if (i >= window) sum -= values[i - window];
    if (i >= window - 1) out[i] = sum / window;
  }
  return out;
}

/**
 * Standard deviation (population, ddof=0) по rolling window. Соответствует
 * `pandas.Series.rolling(window).std(ddof=0)`. Первые `window-1` = NaN.
 */
function rollingStd(values: number[], window: number): number[] {
  const n = values.length;
  const out: number[] = new Array(n).fill(Number.NaN);
  if (n < window) return out;
  for (let i = window - 1; i < n; i++) {
    let mean = 0;
    for (let j = i - window + 1; j <= i; j++) mean += values[j];
    mean /= window;
    let sqSum = 0;
    for (let j = i - window + 1; j <= i; j++) {
      const d = values[j] - mean;
      sqSum += d * d;
    }
    out[i] = Math.sqrt(sqSum / window);
  }
  return out;
}

/**
 * RSI по Wilder'у. alpha = 1/window.
 * Возвращает значения в [0, 100]. Первые `window-1` баров — **100** (не NaN!),
 * это quirk Python source: `.where(avg_loss > 0, 100.0)` заполняет NaN на 100.
 *
 * Port src/analysis/indicators.py:rsi. Parity verified.
 */
export function rsi(values: number[], window = 14): number[] {
  if (window <= 0) throw new Error("rsi: window must be > 0");
  const n = values.length;
  const out: number[] = new Array(n).fill(Number.NaN);
  if (n === 0) return out;

  // delta[i] = values[i] - values[i-1]; первая = NaN. Pandas .where(delta>0, 0)
  // заменяет NaN на 0 тоже (NaN > 0 = False) → gains[0] = losses[0] = 0.
  const gains: number[] = new Array(n).fill(0);
  const losses: number[] = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const d = values[i] - values[i - 1];
    gains[i] = d > 0 ? d : 0;
    losses[i] = d < 0 ? -d : 0;
  }

  // EWM с alpha=1/window, adjust=False. seed = first value.
  // Python `rsi_value.where(avg_loss > 0, 100.0)` заполняет NaN/0 → 100.
  // Это применяется ко всем позициям (включая первые window-1 где Python
  // min_periods даёт NaN, который > 0 = False → 100). Поэтому output ВСЕГДА
  // конечен в этой функции.
  const alpha = 1 / window;
  let avgGain = gains[0];
  let avgLoss = losses[0];
  // Index 0: avg_loss is 0 (seed) → Python NaN → 100.
  out[0] = 100;
  for (let i = 1; i < n; i++) {
    avgGain = alpha * gains[i] + (1 - alpha) * avgGain;
    avgLoss = alpha * losses[i] + (1 - alpha) * avgLoss;
    if (i < window - 1) {
      // Python: NaN в этой позиции (min_periods) → .where заполняет 100.
      out[i] = 100;
    } else if (avgLoss > 0) {
      const rs = avgGain / avgLoss;
      out[i] = 100 - 100 / (1 + rs);
    } else {
      out[i] = 100;
    }
  }
  return out;
}

/**
 * MACD histogram = MACD line - signal line.
 * MACD line = EMA(fast) - EMA(slow); signal = EMA(MACD, signal).
 * Port src/analysis/indicators.py:macd_histogram.
 */
export function macdHistogram(values: number[], fast = 12, slow = 26, signal = 9): number[] {
  const fastE = ema(values, fast);
  const slowE = ema(values, slow);
  const macd: number[] = values.map((_, i) =>
    Number.isNaN(fastE[i]) || Number.isNaN(slowE[i]) ? Number.NaN : fastE[i] - slowE[i],
  );
  const signalE = ema(macd, signal);
  return macd.map((m, i) =>
    Number.isNaN(m) || Number.isNaN(signalE[i]) ? Number.NaN : m - signalE[i],
  );
}

/**
 * Bollinger Bands: (lower, middle, upper). middle = SMA, std через rolling.
 */
export function bollingerBands(
  values: number[],
  window = 20,
  numStd = 2,
): { lower: number[]; middle: number[]; upper: number[] } {
  const middle = sma(values, window);
  const std = rollingStd(values, window);
  const upper = middle.map((m, i) => (Number.isNaN(m) ? Number.NaN : m + numStd * std[i]));
  const lower = middle.map((m, i) => (Number.isNaN(m) ? Number.NaN : m - numStd * std[i]));
  return { lower, middle, upper };
}

/**
 * Average True Range (Wilder). Port src/analysis/indicators.py:atr.
 */
export function atr(high: number[], low: number[], close: number[], window = 14): number[] {
  const n = high.length;
  if (low.length !== n || close.length !== n) {
    throw new Error("atr: high/low/close must have same length");
  }
  // True Range
  const tr: number[] = new Array(n).fill(Number.NaN);
  for (let i = 0; i < n; i++) {
    if (i === 0) {
      tr[i] = high[i] - low[i];
    } else {
      const prevC = close[i - 1];
      tr[i] = Math.max(high[i] - low[i], Math.abs(high[i] - prevC), Math.abs(low[i] - prevC));
    }
  }
  // EWM с alpha = 1/window, adjust=False, min_periods=window.
  const out: number[] = new Array(n).fill(Number.NaN);
  if (n < window) return out;
  const alpha = 1 / window;
  let prev = tr[0];
  for (let i = 1; i < n; i++) {
    prev = alpha * tr[i] + (1 - alpha) * prev;
    if (i >= window - 1) out[i] = prev;
  }
  return out;
}

/**
 * Percentile rank: доля values < target (в процентах). NaN игнорируется.
 * Port src/analysis/indicators.py:percentile_rank.
 */
export function percentileRank(values: number[], target: number): number {
  const clean = values.filter((v) => !Number.isNaN(v) && Number.isFinite(v));
  if (clean.length === 0) return Number.NaN;
  const below = clean.filter((v) => v < target).length;
  return (below / clean.length) * 100;
}

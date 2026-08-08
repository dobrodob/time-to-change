/**
 * Hourly analyze job — multi-asset.
 *
 * Pipeline (для каждого active asset):
 *   1. Market open check (per asset type)
 *   2. Fetch OHLC daily + hourly через correct provider (TwelveData / MOEX)
 *   3. Per subscribed direction (buy/sell):
 *      a. Compute direction-aware score
 *      b. Gate (regime + edge + cooldown per asset+direction + blackout)
 *      c. If passes: append history + broadcast subscribers of (asset, direction)
 *   4. Save last_score_breakdown в asset_state для /explain
 */
import { alertInlineKeyboard, formatAlert } from "../commands/formatter";
import type { ValidatedEnv } from "../env";
import { log } from "../lib/log";
import { isInQuietWindow, nowIso } from "../lib/time";
import { StateRepo } from "../state/repo";
import type { Asset, Direction, LastScoreBreakdown, User } from "../state/schema";
import { TelegramAuthError, TelegramBlockedError, TelegramClient } from "../telegram/api";
import { findBlackout } from "./events-filter";
import { type GateDecision, computeDailyEdgePct, computeEdgePct, decide } from "./gating";
import { isMarketOpenForType } from "./market-calendar";
import { TwelveDataQuotaError, getProviderForAsset } from "./providers";
import { type Candle, type ScoreBreakdown, computeScore } from "./scoring";

const MIN_EDGE_PCT = 0;
const COOLDOWN_HOURS = 24;
const DAILY_CANDLES = 200;
const HOURLY_CANDLES = 200;

export async function runAnalyze(env: ValidatedEnv): Promise<void> {
  const repo = new StateRepo(env.DB);
  const now = nowIso();

  const activeAssets = await repo.listActiveAssets();
  if (activeAssets.length === 0) {
    log("info", "analyze_no_active_assets");
    return;
  }
  log("info", "analyze_starting", { active_assets: activeAssets.length });

  for (const asset of activeAssets) {
    try {
      await analyzeAsset(env, repo, asset, now);
    } catch (err) {
      if (err instanceof TelegramAuthError) throw err; // fatal
      log("error", "analyze_asset_failed", {
        symbol: asset.symbol,
        error: String(err).slice(0, 200),
      });
    }
  }
}

async function analyzeAsset(
  env: ValidatedEnv,
  repo: StateRepo,
  asset: Asset,
  now: string,
): Promise<void> {
  if (!isMarketOpenForType(asset.type, now)) {
    log("info", "asset_market_closed", { symbol: asset.symbol, type: asset.type });
    return;
  }

  const provider = getProviderForAsset(asset, env.TWELVEDATA_API_KEY);
  let daily: Candle[];
  let hourly: Candle[];
  let totalCredits = 0;
  try {
    const dailyRes = await provider.fetchCandles(asset.symbol, "1day", DAILY_CANDLES);
    daily = dailyRes.candles;
    totalCredits += dailyRes.creditsUsed;
    const hourlyRes = await provider.fetchCandles(asset.symbol, "1h", HOURLY_CANDLES);
    hourly = hourlyRes.candles;
    totalCredits += hourlyRes.creditsUsed;
  } catch (err) {
    if (err instanceof TwelveDataQuotaError) {
      log("error", "analyze_quota_exhausted", { symbol: asset.symbol });
      return;
    }
    throw err;
  }

  if (totalCredits > 0) await repo.bumpAssetQuota(asset.symbol, totalCredits);

  // Compute baseline (direction-agnostic, both p90 для sell + p10 для buy).
  const closes = daily.map((c) => c.close);
  const median30d = computeMedian(closes.slice(-30));
  const p90_90d = computePercentile(closes.slice(-90), 0.9);
  const p10_90d = computePercentile(closes.slice(-90), 0.1);
  await repo.setAssetBaseline(asset.symbol, median30d ?? 0, p90_90d ?? 0, p10_90d ?? 0, now);

  // Дневной edge (вчера → сегодня) — direction-agnostic, считается из daily candles.
  // Используется в утреннем digest как «Edge за день». null если истории <2 дней.
  const dailyEdgePct = computeDailyEdgePct(daily);

  const assetState = await repo.getAssetState(asset.symbol);
  const upcoming = await repo.getUpcomingEvent(now);
  const events = upcoming !== null ? [upcoming] : [];
  const blackout = findBlackout(now, events);

  // Кэшируем breakdown первого direction для last_score_breakdown
  // (используется /explain; для simplicity сохраняем direction-agnostic "sell" view).
  let primaryBreakdown: ScoreBreakdown | null = null;
  let primaryEdge = 0;

  // Для каждого direction: считаем score, gate, broadcast.
  for (const dir of ["sell", "buy"] as const) {
    // Skip если у asset нет подписчиков на эту direction
    const subscribers = await repo.listSubscribers(asset.symbol, dir);
    if (subscribers.length === 0) continue;

    const breakdown = computeScore(daily, hourly, dir, asset.type);
    const edgePct = computeEdgePct(breakdown.rate, median30d);

    // Cache primary breakdown (sell direction если есть, иначе первый)
    if (primaryBreakdown === null || dir === "sell") {
      primaryBreakdown = breakdown;
      primaryEdge = edgePct;
    }

    // Last alert для этого direction — из asset_state
    const lastAlert =
      assetState !== null && dir === "sell"
        ? assetState.last_alert_sell_ts !== null
          ? {
              ts: assetState.last_alert_sell_ts,
              regime: assetState.last_alert_sell_regime ?? "cooldown",
              score: assetState.last_alert_sell_score ?? 0,
              rate: 0,
              edge_pct: 0,
            }
          : null
        : assetState !== null && dir === "buy"
          ? assetState.last_alert_buy_ts !== null
            ? {
                ts: assetState.last_alert_buy_ts,
                regime: assetState.last_alert_buy_regime ?? "cooldown",
                score: assetState.last_alert_buy_score ?? 0,
                rate: 0,
                edge_pct: 0,
              }
            : null
          : null;

    const gate: GateDecision = decide({
      newRegime: breakdown.regime,
      edgePct,
      blackoutEvent: blackout
        ? { type: blackout.type, title: blackout.title, ts: blackout.ts }
        : null,
      lastAlert,
      now,
      minEdgePct: MIN_EDGE_PCT,
      cooldownHours: COOLDOWN_HOURS,
    });

    log("info", "asset_analyze_done", {
      symbol: asset.symbol,
      direction: dir,
      score: breakdown.score,
      regime: breakdown.regime,
      rate: breakdown.rate,
      edge_pct: edgePct,
      gate_allow: gate.allow,
      gate_reason: gate.reason,
    });

    if (!gate.allow) continue;

    // Алерт идёт — append history + broadcast.
    await repo.appendAlertForAsset(asset.symbol, dir, {
      ts: now,
      regime: breakdown.regime,
      score: breakdown.score,
      rate: breakdown.rate,
      edge_pct: edgePct,
    });

    await broadcastAlertForAsset(env, repo, asset, dir, breakdown, edgePct, now, subscribers);
  }

  // Persist breakdown для /explain
  if (primaryBreakdown !== null) {
    const lastScore: LastScoreBreakdown = {
      ts: now,
      score: primaryBreakdown.score,
      regime: primaryBreakdown.regime,
      rate: primaryBreakdown.rate,
      edge_pct: primaryEdge,
      daily_edge_pct: dailyEdgePct,
      components: primaryBreakdown.components,
      notes: primaryBreakdown.notes,
      was_alert: false, // direction-specific, here global summary
      gate_reason: null,
    };
    await repo.setAssetLastScoreBreakdown(asset.symbol, lastScore);
  }
}

async function broadcastAlertForAsset(
  env: ValidatedEnv,
  repo: StateRepo,
  asset: Asset,
  direction: Direction,
  breakdown: ScoreBreakdown,
  edgePct: number,
  nowIso_: string,
  subscribers: { chat_id: number }[],
): Promise<void> {
  const tg = new TelegramClient(env.TELEGRAM_BOT_TOKEN);
  const state = await repo.getBotState();
  const text = formatAlert(breakdown, edgePct, nowIso_, state, "Europe/Madrid", {
    asset,
    direction,
  });
  const keyboard = alertInlineKeyboard(breakdown, state, nowIso_, { asset, direction });

  for (const sub of subscribers) {
    const user = await repo.getUser(sub.chat_id);
    if (user === null || !eligibleForAlert(user, nowIso_)) {
      log("info", "alert_skip_user_state", { chat_id: sub.chat_id, symbol: asset.symbol });
      continue;
    }
    try {
      await tg.sendMessage(user.chat_id, text, { reply_markup: keyboard });
      log("info", "alert_sent", {
        chat_id: user.chat_id,
        symbol: asset.symbol,
        direction,
      });
    } catch (err) {
      if (err instanceof TelegramAuthError) throw err;
      if (err instanceof TelegramBlockedError) {
        log("warn", "alert_blocked", { chat_id: user.chat_id, symbol: asset.symbol });
        continue;
      }
      log("error", "alert_send_failed", {
        chat_id: user.chat_id,
        symbol: asset.symbol,
        error: String(err).slice(0, 200),
      });
    }
  }
}

function eligibleForAlert(user: User, nowIso_: string): boolean {
  if (user.silence_active && user.silence_until !== null) {
    if (new Date(user.silence_until).getTime() > new Date(nowIso_).getTime()) {
      return false;
    }
  }
  if (user.quiet_enabled && isInQuietWindow(nowIso_, user.quiet_from_hour, user.quiet_to_hour)) {
    return false;
  }
  return true;
}

function computeMedian(arr: number[]): number | null {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function computePercentile(arr: number[], q: number): number | null {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx];
}

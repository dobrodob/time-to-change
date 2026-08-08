/**
 * Morning digest job — port of src/cli/digest.py.
 *
 * Окно срабатывания: Madrid 11:25–11:55 (т.е. ±15 минут от 11:42). Запускается
 * через две cron triggers (9:25 UTC + 10:25 UTC) для cover CEST/CET DST.
 * Idempotency: skip if last_digest_at < 12h ago.
 *
 * Содержание: курс + edge + regime + budget block для opt-in users.
 * Не выходит в quiet hours / silence.
 */
import type { Regime, ScoreBreakdown } from "../analyze/scoring";
import { formatDigest, formatDigestMultiAssetSummary } from "../commands/formatter";
import type { ValidatedEnv } from "../env";
import { log } from "../lib/log";
import { isInQuietWindow, madridHourFromUtc, nowIso } from "../lib/time";
import { StateRepo } from "../state/repo";
import type { Asset, AssetState, User } from "../state/schema";
import { TelegramAuthError, TelegramBlockedError, TelegramClient } from "../telegram/api";

const TZ = "Europe/Madrid";
const DIGEST_HOUR = 11;
const DIGEST_MIN = 42;
const TOLERANCE_MIN = 30;

export async function runDigest(env: ValidatedEnv): Promise<void> {
  const now = nowIso();
  const repo = new StateRepo(env.DB);
  const state = await repo.getBotState();

  // Window check (Madrid local time).
  const madridHour = madridHourFromUtc(now);
  if (!isInDigestWindow(now, madridHour)) {
    log("info", "digest_outside_window", { madrid_hour: madridHour });
    return;
  }

  // Idempotency: skip if recent digest.
  if (state.last_digest_at !== null) {
    const last = new Date(state.last_digest_at).getTime();
    const elapsed = new Date(now).getTime() - last;
    if (elapsed < 12 * 3600 * 1000) {
      log("info", "digest_skip_recent", { last: state.last_digest_at });
      return;
    }
  }

  // Build breakdown from asset_state.last_score_breakdown (post-migration
  // источник истины — analyze/job.ts пишет туда per-asset). bot_state остаётся
  // singleton для budget данных. См. plan shimmying-orbiting-deer.md.
  const assetState = await repo.getPrimaryAssetState();
  let breakdown: ScoreBreakdown | null = null;
  let edgePct: number | null = null;
  let dailyEdgePct: number | null = null;
  if (assetState?.last_score_breakdown != null) {
    breakdown = {
      score: assetState.last_score_breakdown.score,
      regime: assetState.last_score_breakdown.regime as Regime,
      rate: assetState.last_score_breakdown.rate,
      components: assetState.last_score_breakdown.components,
      notes: assetState.last_score_breakdown.notes,
    };
    edgePct = assetState.last_score_breakdown.edge_pct;
    // null для legacy записей до feat/digest-daily-edge или для assets с <2 daily candles
    dailyEdgePct = assetState.last_score_breakdown.daily_edge_pct ?? null;
  }

  // Базовый text без multi-asset summary — для юзеров без non-EUR/USD подписок.
  const baseText = formatDigest(state, breakdown, edgePct, dailyEdgePct, now, TZ, null);

  const users = await repo.listUsers();
  const tg = new TelegramClient(env.TELEGRAM_BOT_TOKEN);
  let sent = 0;
  for (const user of users) {
    if (!eligibleForDigest(user, now)) continue;
    const text = await buildDigestForUser(
      repo,
      user,
      state,
      breakdown,
      edgePct,
      dailyEdgePct,
      now,
      baseText,
    );
    try {
      await tg.sendMessage(user.chat_id, text);
      sent++;
    } catch (err) {
      if (err instanceof TelegramAuthError) throw err;
      if (err instanceof TelegramBlockedError) {
        log("warn", "digest_blocked", { chat_id: user.chat_id });
        continue;
      }
      log("error", "digest_send_failed", {
        chat_id: user.chat_id,
        error: String(err).slice(0, 200),
      });
    }
  }
  await repo.setLastDigestAt(now);
  log("info", "digest_done", { sent, total: users.length });
}

/**
 * Per-user digest text: appendoes summary не-EUR/USD подписок (если есть).
 * Для юзеров с подписками только на EUR/USD возвращает baseText без изменений
 * — экономим круги в DB.
 */
async function buildDigestForUser(
  repo: StateRepo,
  user: User,
  state: import("../state/schema").BotState,
  breakdown: ScoreBreakdown | null,
  edgePct: number | null,
  dailyEdgePct: number | null,
  now: string,
  baseText: string,
): Promise<string> {
  const subs = await repo.listUserSubscriptions(user.chat_id);
  const nonEurUsd = subs.filter((s) => s.symbol !== "EUR/USD");
  if (nonEurUsd.length === 0) return baseText;

  const assets: Record<string, Asset> = {};
  const states: Record<string, AssetState | null> = {};
  for (const s of nonEurUsd) {
    const a = await repo.getAsset(s.symbol);
    if (a) assets[s.symbol] = a;
    states[s.symbol] = await repo.getAssetState(s.symbol);
  }
  const summary = formatDigestMultiAssetSummary(subs, assets, states, now);
  return formatDigest(state, breakdown, edgePct, dailyEdgePct, now, TZ, summary);
}

function isInDigestWindow(_now: string, madridHour: number): boolean {
  // Окно 11:25-11:55 Madrid. Конвертация в minutes-of-day для проверки.
  // Упрощённо: hour == 11 — достаточно для cron, который срабатывает раз в час.
  return madridHour === DIGEST_HOUR;
}

function eligibleForDigest(user: User, nowIso_: string): boolean {
  if (!user.digest_enabled) return false;
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

// Suppress unused param warning (kept для будущего refinement окна).
void TOLERANCE_MIN;
void DIGEST_MIN;

/**
 * Self-diagnosing freshness monitor.
 *
 * Cron trigger вызывает runFreshnessCheck каждые N часов. Логика:
 *   1. Для КАЖДОГО active-актива (EUR/USD + металлы Yahoo + прочие): open ли
 *      рынок. Закрыт — staleness ожидаема, не алертим (forex weekend и т.п.).
 *   2. При открытом рынке asset_state.last_score_breakdown.ts должен быть свежим
 *      (analyze cron каждый час). Старше THRESHOLD (2ч) → попадает в один
 *      агрегированный alert owner'у в Telegram. Раньше следили только за
 *      EUR/USD — металлы на flaky Yahoo могли молча протухнуть незамеченными.
 *
 * Закрывает класс багов "frozen state молчит" (см. PR #23 / PR #24 / PR #25 history)
 * без external monitoring service: бот сам себя диагностирует.
 */
import { isMarketOpenForType } from "../analyze/market-calendar";
import type { ValidatedEnv } from "../env";
import { log } from "../lib/log";
import { nowIso } from "../lib/time";
import { StateRepo } from "../state/repo";
import type { Asset, AssetState, AssetType } from "../state/schema";
import { TelegramAuthError, TelegramBlockedError, TelegramClient } from "../telegram/api";

// Hourly analyze cron + 1 час grace. Меньше — false positives при одном
// пропущенном tick'е (рестарт worker'а, transient TwelveData fail).
export const FRESHNESS_ALERT_THRESHOLD_SECONDS = 7200;

export interface FreshnessDecision {
  alert: boolean;
  reason: "no_asset" | "market_closed" | "never_analyzed" | "fresh" | "stale";
  freshness_seconds: number | null;
}

/**
 * Pure-функция для решения «нужен ли alert». Изолирована от I/O для unit-testing.
 */
export function evaluateFreshness(
  asset: Asset | null,
  state: AssetState | null,
  nowIso_: string,
  thresholdSeconds = FRESHNESS_ALERT_THRESHOLD_SECONDS,
): FreshnessDecision {
  if (asset === null) {
    return { alert: false, reason: "no_asset", freshness_seconds: null };
  }
  if (!isMarketOpenForType(asset.type, nowIso_)) {
    return { alert: false, reason: "market_closed", freshness_seconds: null };
  }
  const lastTs = state?.last_score_breakdown?.ts ?? null;
  if (lastTs === null) {
    return { alert: false, reason: "never_analyzed", freshness_seconds: null };
  }
  const freshnessSeconds = Math.floor(
    (new Date(nowIso_).getTime() - new Date(lastTs).getTime()) / 1000,
  );
  if (freshnessSeconds <= thresholdSeconds) {
    return { alert: false, reason: "fresh", freshness_seconds: freshnessSeconds };
  }
  return { alert: true, reason: "stale", freshness_seconds: freshnessSeconds };
}

export interface StaleAsset {
  symbol: string;
  type: AssetType;
  freshness_seconds: number;
}

/**
 * Pure: из (asset, state) пар выбирает протухшие (рынок открыт + staleness >
 * порога). Переиспользует evaluateFreshness. Свежие / закрытый рынок /
 * never_analyzed (только что подписались) НЕ попадают.
 *
 * Зачем все активы, а не только EUR/USD: с приходом Yahoo-металлов появился
 * второй класс активов, чей фид (бесплатный flaky Yahoo) может молча протухнуть —
 * раньше монитор его не видел.
 */
export function collectStaleAssets(
  entries: Array<{ asset: Asset; state: AssetState | null }>,
  nowIso_: string,
  thresholdSeconds = FRESHNESS_ALERT_THRESHOLD_SECONDS,
): StaleAsset[] {
  const stale: StaleAsset[] = [];
  for (const { asset, state } of entries) {
    const d = evaluateFreshness(asset, state, nowIso_, thresholdSeconds);
    if (d.alert && d.freshness_seconds !== null) {
      stale.push({
        symbol: asset.symbol,
        type: asset.type,
        freshness_seconds: d.freshness_seconds,
      });
    }
  }
  return stale;
}

function formatFreshnessAlert(stale: StaleAsset[]): string {
  const thresholdHours = FRESHNESS_ALERT_THRESHOLD_SECONDS / 3600;
  const lines = stale.map(
    (s) => `• <b>${s.symbol}</b> — ${(s.freshness_seconds / 3600).toFixed(1)}ч`,
  );
  return `⚠ <b>Analyze молчит по активам</b> (рынок открыт)

${lines.join("\n")}

Старше порога ${thresholdHours}ч. Проверь /health + wrangler tail + квоту TwelveData / доступность Yahoo (металлы).`;
}

/**
 * Cron-entrypoint. Проверяет свежесть ВСЕХ active-активов (не только EUR/USD),
 * шлёт owner'у один агрегированный алерт по протухшим.
 */
export async function runFreshnessCheck(env: ValidatedEnv): Promise<void> {
  const repo = new StateRepo(env.DB);
  const now = nowIso();

  const assets = await repo.listActiveAssets();
  const entries: Array<{ asset: Asset; state: AssetState | null }> = [];
  for (const asset of assets) {
    entries.push({ asset, state: await repo.getAssetState(asset.symbol) });
  }
  const stale = collectStaleAssets(entries, now);

  log("info", "freshness_check", { active: assets.length, stale: stale.length });
  if (stale.length === 0) return;

  const owner = await repo.getOwner();
  if (owner === null) {
    log("warn", "freshness_check_no_owner");
    return;
  }

  const tg = new TelegramClient(env.TELEGRAM_BOT_TOKEN);
  try {
    await tg.sendMessage(owner.chat_id, formatFreshnessAlert(stale));
    log("warn", "freshness_check_alert_sent", { stale: stale.map((s) => s.symbol) });
  } catch (err) {
    if (err instanceof TelegramAuthError) throw err;
    if (err instanceof TelegramBlockedError) {
      log("warn", "freshness_check_alert_blocked", { chat_id: owner.chat_id });
      return;
    }
    log("error", "freshness_check_alert_failed", { error: String(err).slice(0, 200) });
  }
}

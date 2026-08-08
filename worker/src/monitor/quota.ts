/**
 * Суточный сброс quota_credits_today — cron-entrypoint (`1 0 * * *`, 00:01 UTC,
 * синхронно с UTC-циклом сброса квоты TwelveData).
 *
 * Без него счётчик копился с cut-over без обнуления (lifetime, а не «за сегодня»)
 * — `/health` `quota_credits_used_today` врал. Метрика observability-only (квоту
 * не гейтит — реальная защита реактивная TwelveDataQuotaError), но теперь честная.
 */
import type { ValidatedEnv } from "../env";
import { log } from "../lib/log";
import { StateRepo } from "../state/repo";

export async function runQuotaReset(env: ValidatedEnv): Promise<void> {
  const repo = new StateRepo(env.DB);
  const reset = await repo.resetAllQuota();
  log("info", "quota_reset_done", { assets_reset: reset });
}

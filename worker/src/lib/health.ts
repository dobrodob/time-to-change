/**
 * /health endpoint — liveness probe + summary status.
 * Возвращает JSON с критичными метриками: schema_version, last_update_id,
 * last_analyze_at, last_digest_at, users_count, analyze_freshness_seconds.
 *
 * Используется UptimeRobot/cron-job.org для external monitoring и в CI smoke test.
 *
 * **last_analyze_at читается из asset_state (primary EUR/USD)** — bot_state.last_score_breakdown_json
 * deprecated после multi-asset миграции и физически не обновляется. См. PR #23.
 */
import type { ValidatedEnv } from "../env";
import { StateRepo } from "../state/repo";

export async function handleHealth(env: ValidatedEnv): Promise<Response> {
  try {
    const repo = new StateRepo(env.DB);
    const state = await repo.getBotState();
    const primary = await repo.getPrimaryAssetState();
    const usersCount = await repo.countUsers();
    const quotaTotal = await repo.getTotalAssetQuotaToday();
    const lastAnalyzeAt = primary?.last_score_breakdown?.ts ?? null;
    const now = new Date();
    const analyzeFreshnessSeconds =
      lastAnalyzeAt !== null
        ? Math.floor((now.getTime() - new Date(lastAnalyzeAt).getTime()) / 1000)
        : null;
    return Response.json({
      ok: true,
      schema_version: state.schema_version,
      last_update_id: state.last_update_id,
      last_analyze_at: lastAnalyzeAt,
      analyze_freshness_seconds: analyzeFreshnessSeconds,
      last_digest_at: state.last_digest_at,
      users_count: usersCount,
      quota_credits_used_today: quotaTotal,
      ts: now.toISOString(),
    });
  } catch (err) {
    return Response.json({ ok: false, error: String(err).slice(0, 300) }, { status: 500 });
  }
}

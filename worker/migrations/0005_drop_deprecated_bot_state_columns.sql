-- Удаляем 8 dead columns из bot_state после multi-asset cut-over (12.05.2026).
-- Эти поля имели writers только в legacy Python / pre-migration TypeScript коде.
-- После #16-19 multi-asset migration все analyze writes ушли в asset_state per-symbol;
-- bot_state остался писать только schema_version, last_update_id, menu, last_digest_at,
-- budget_*. PR #23 закрыл readers; PR #24 убирает physical columns + dead writers.
--
-- См. план shimmying-orbiting-deer.md (Phase 2 follow-up tech debt).
-- D1 / SQLite 3.35+ поддерживает ALTER TABLE DROP COLUMN атомарно.

ALTER TABLE bot_state DROP COLUMN baseline_rolling_median_30d;
ALTER TABLE bot_state DROP COLUMN baseline_rolling_p90_90d;
ALTER TABLE bot_state DROP COLUMN baseline_computed_at;
ALTER TABLE bot_state DROP COLUMN quota_credits_used_today;
ALTER TABLE bot_state DROP COLUMN quota_reset_at;
ALTER TABLE bot_state DROP COLUMN consecutive_failures;
ALTER TABLE bot_state DROP COLUMN last_alert_json;
ALTER TABLE bot_state DROP COLUMN last_score_breakdown_json;

-- Bump schema_version для signaling structural change.
UPDATE bot_state SET schema_version = 5 WHERE id = 1;

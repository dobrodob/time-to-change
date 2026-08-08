-- Seed: EUR/USD asset + миграция existing 3 users → subscription direction=sell.
-- После cut-over к multi-asset existing users продолжают получать EUR/USD алерты как раньше.

-- 1. EUR/USD asset row.
INSERT OR IGNORE INTO assets (symbol, display_name, type, provider, currency, active, added_at)
  VALUES ('EUR/USD', 'Евро/Доллар', 'forex', 'twelvedata', 'USD', 1, '2026-05-12T12:00:00Z');

-- 2. Asset state — копируем существующий baseline + last_alert из bot_state.
INSERT OR IGNORE INTO asset_state (
  symbol,
  baseline_rolling_median_30d,
  baseline_rolling_p90_90d,
  baseline_rolling_p10_90d,
  baseline_computed_at,
  last_alert_sell_ts,
  last_alert_sell_regime,
  last_alert_sell_score,
  last_score_breakdown_json,
  quota_credits_today
)
SELECT
  'EUR/USD',
  bot_state.baseline_rolling_median_30d,
  bot_state.baseline_rolling_p90_90d,
  NULL,
  bot_state.baseline_computed_at,
  json_extract(bot_state.last_alert_json, '$.ts'),
  json_extract(bot_state.last_alert_json, '$.regime'),
  json_extract(bot_state.last_alert_json, '$.score'),
  bot_state.last_score_breakdown_json,
  bot_state.quota_credits_used_today
FROM bot_state WHERE id = 1;

-- 3. Existing users → автоподписка на EUR/USD direction=sell.
-- (Это сохраняет текущее поведение бота — все 3 users продолжают получать EUR/USD sell alerts.)
INSERT OR IGNORE INTO subscriptions (chat_id, symbol, direction, subscribed_at)
SELECT chat_id, 'EUR/USD', 'sell', '2026-05-12T12:00:00Z' FROM users;

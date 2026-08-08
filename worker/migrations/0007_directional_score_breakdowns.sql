-- Keep independent analysis snapshots for buy and sell subscriptions.
-- The previous shared column preferred sell whenever both directions existed,
-- so a buy subscriber could receive the wrong score in /status and digests.

ALTER TABLE asset_state ADD COLUMN last_score_breakdown_sell_json TEXT;
ALTER TABLE asset_state ADD COLUMN last_score_breakdown_buy_json TEXT;

-- The legacy writer preferred sell. Backfill it as sell whenever sell exists.
UPDATE asset_state
SET last_score_breakdown_sell_json = last_score_breakdown_json
WHERE last_score_breakdown_json IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM subscriptions s
    WHERE s.symbol = asset_state.symbol AND s.direction = 'sell'
  );

-- It represented buy only for assets without a sell subscription.
UPDATE asset_state
SET last_score_breakdown_buy_json = last_score_breakdown_json
WHERE last_score_breakdown_json IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM subscriptions s
    WHERE s.symbol = asset_state.symbol AND s.direction = 'sell'
  )
  AND EXISTS (
    SELECT 1 FROM subscriptions s
    WHERE s.symbol = asset_state.symbol AND s.direction = 'buy'
  );

UPDATE bot_state SET schema_version = 6 WHERE id = 1;

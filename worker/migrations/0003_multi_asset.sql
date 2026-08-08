-- Multi-asset поддержка: user × asset × direction подписки.
-- Schema v5: assets registry + subscriptions + per-asset state.
-- См. design discussion: каждый user выбирает on what subscribe и в каком direction (buy/sell).

PRAGMA foreign_keys = ON;

-- ============ Assets registry ============
-- Lazy creation: row создаётся при первом /subscribe.
-- Deactivated (но не удалён) когда все unsubscribe — чтобы history оставалась.
CREATE TABLE assets (
  symbol         TEXT PRIMARY KEY,           -- "EUR/USD", "AAPL", "LKOH", "BTC/USD"
  display_name   TEXT NOT NULL,              -- "Евро/Доллар", "Apple Inc.", "Лукойл"
  type           TEXT NOT NULL CHECK (type IN ('forex', 'stock_us', 'stock_ru', 'crypto', 'commodity', 'index')),
  provider       TEXT NOT NULL CHECK (provider IN ('twelvedata', 'moex')),
  currency       TEXT NOT NULL,              -- "USD", "RUB", "EUR" — display валюта цены
  active         INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  added_at       TEXT NOT NULL
);
CREATE INDEX idx_assets_active ON assets(active) WHERE active = 1;

-- ============ Subscriptions ============
-- (chat_id, symbol, direction) — composite PK. Один user может subscribe на оба направления.
CREATE TABLE subscriptions (
  chat_id        INTEGER NOT NULL,
  symbol         TEXT NOT NULL,
  direction      TEXT NOT NULL CHECK (direction IN ('buy', 'sell')),
  subscribed_at  TEXT NOT NULL,
  PRIMARY KEY (chat_id, symbol, direction),
  FOREIGN KEY (chat_id) REFERENCES users(chat_id) ON DELETE CASCADE,
  FOREIGN KEY (symbol)  REFERENCES assets(symbol) ON DELETE CASCADE
);
CREATE INDEX idx_subscriptions_by_symbol ON subscriptions(symbol, direction);

-- ============ Per-asset state ============
-- Split из bot_state — теперь baseline и last_alert per asset+direction.
-- p10_90d добавлен для buy-direction (low percentile = хороший момент купить).
CREATE TABLE asset_state (
  symbol                          TEXT PRIMARY KEY,
  baseline_rolling_median_30d     REAL,
  baseline_rolling_p90_90d        REAL,        -- для sell direction (high price = good)
  baseline_rolling_p10_90d        REAL,        -- для buy direction (low price = good)
  baseline_computed_at            TEXT,
  -- last_alert по direction (отдельный cooldown для buy и sell)
  last_alert_sell_ts              TEXT,
  last_alert_sell_regime          TEXT,
  last_alert_sell_score           REAL,
  last_alert_buy_ts               TEXT,
  last_alert_buy_regime           TEXT,
  last_alert_buy_score            REAL,
  -- last score breakdown для /explain (один общий, direction-agnostic — детали обоих)
  last_score_breakdown_json       TEXT,
  -- per-asset quota tracking (для twelvedata budget)
  quota_credits_today             INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (symbol) REFERENCES assets(symbol) ON DELETE CASCADE
);

-- ============ alert_history — добавить symbol + direction ============
ALTER TABLE alert_history ADD COLUMN symbol    TEXT NOT NULL DEFAULT 'EUR/USD';
ALTER TABLE alert_history ADD COLUMN direction TEXT NOT NULL DEFAULT 'sell';
CREATE INDEX idx_alert_history_symbol_ts ON alert_history(symbol, ts);

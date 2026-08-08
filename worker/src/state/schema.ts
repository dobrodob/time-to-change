/**
 * Zod schemas — точное зеркало D1 tables (migrations/0001_initial.sql).
 * Используется в StateRepo как validator выхода D1 → throw на schema mismatch
 * (защита от drift между миграциями и кодом).
 *
 * D1 (SQLite) хранит booleans как INTEGER 0/1. StateRepo переводит в boolean
 * перед валидацией, чтобы доменные типы были чистыми.
 */
import { z } from "zod";

// ============ Enums / domain ============

export const userRole = z.enum(["owner", "member"]);
export type UserRole = z.infer<typeof userRole>;

// ISO 8601 UTC timestamp (грубая проверка — не паттерн, чтобы не отвергать
// валидные D1 values от Date.now → toISOString).
const isoString = z.string().min(1);

// ============ User ============

export const userSchema = z.object({
  chat_id: z.number().int(),
  role: userRole,
  name: z.string().nullable(),
  joined_at: isoString,
  silence_active: z.boolean(),
  silence_until: isoString.nullable(),
  silence_reason: z.string().nullable(),
  quiet_enabled: z.boolean(),
  quiet_from_hour: z.number().int().min(0).max(23),
  quiet_to_hour: z.number().int().min(0).max(23),
  digest_enabled: z.boolean(),
});
export type User = z.infer<typeof userSchema>;

// ============ Alert / score ============

export const alertRecordSchema = z.object({
  ts: isoString,
  regime: z.string(),
  score: z.number(),
  rate: z.number(),
  edge_pct: z.number(),
  // Multi-asset columns (added в migration 0003, могут быть null для legacy
  // EUR/USD-only alerts до cut-over).
  symbol: z.string().nullable().optional(),
  direction: z.enum(["buy", "sell"]).nullable().optional(),
});
export type AlertRecord = z.infer<typeof alertRecordSchema>;

export const lastScoreBreakdownSchema = z.object({
  ts: isoString,
  score: z.number(),
  regime: z.string(),
  rate: z.number(),
  edge_pct: z.number(),
  // % изменения относительно вчерашней дневной свечи. Optional + nullable —
  // optional для backward compat с legacy записями (до feat/digest-daily-edge),
  // nullable для assets с <2 daily candles (новые подписки без истории).
  daily_edge_pct: z.number().nullable().optional(),
  components: z.record(z.string(), z.number().nullable()),
  notes: z.array(z.string()),
  was_alert: z.boolean(),
  gate_reason: z.string().nullable(),
});
export type LastScoreBreakdown = z.infer<typeof lastScoreBreakdownSchema>;

// ============ Bot state (singleton) ============

/**
 * Bot state (singleton). После migration 0005 (PR #24, 14.05.2026) поля baseline_*,
 * quota_*, consecutive_failures, last_alert_json, last_score_breakdown_json удалены —
 * они переехали в asset_state (per-symbol) или совсем deprecated. bot_state теперь
 * хранит только: schema (1 поле), Telegram pollstate, menu UI cache, digest tracking,
 * budget singleton. Multi-asset breakdown/baseline/quota — в `assetStateSchema`.
 */
export const botStateSchema = z.object({
  schema_version: z.number().int(),
  last_update_id: z.number().int(),
  menu_set_at: isoString.nullable(),
  menu_commands_count: z.number().int(),
  last_digest_at: isoString.nullable(),
  budget_target_eur: z.number().nullable(),
  budget_deadline: isoString.nullable(),
  budget_started_at: isoString.nullable(),
  budget_converted_eur: z.number(),
  budget_converted_usd: z.number(),
});
export type BotState = z.infer<typeof botStateSchema>;

// ============ Conversion / event ============

export const conversionSchema = z.object({
  id: z.number().int().optional(),
  ts: isoString,
  eur: z.number(),
  rate: z.number(),
  pct_at_alert: z.number().int().nullable(),
});
export type Conversion = z.infer<typeof conversionSchema>;

export const eventSchema = z.object({
  id: z.number().int(),
  ts: isoString,
  type: z.string(),
  description: z.string().nullable(),
});
export type Event = z.infer<typeof eventSchema>;

// ============ Multi-asset (v5) ============

export const assetType = z.enum(["forex", "stock_us", "stock_ru", "crypto", "commodity", "index"]);
export type AssetType = z.infer<typeof assetType>;

export const assetProvider = z.enum(["twelvedata", "moex"]);
export type AssetProvider = z.infer<typeof assetProvider>;

export const direction = z.enum(["buy", "sell"]);
export type Direction = z.infer<typeof direction>;

export const assetSchema = z.object({
  symbol: z.string().min(1),
  display_name: z.string().min(1),
  type: assetType,
  provider: assetProvider,
  currency: z.string().min(1),
  active: z.boolean(),
  added_at: isoString,
});
export type Asset = z.infer<typeof assetSchema>;

export const subscriptionSchema = z.object({
  chat_id: z.number().int(),
  symbol: z.string().min(1),
  direction,
  subscribed_at: isoString,
});
export type Subscription = z.infer<typeof subscriptionSchema>;

export const assetStateSchema = z.object({
  symbol: z.string().min(1),
  baseline_rolling_median_30d: z.number().nullable(),
  baseline_rolling_p90_90d: z.number().nullable(),
  baseline_rolling_p10_90d: z.number().nullable(),
  baseline_computed_at: isoString.nullable(),
  last_alert_sell_ts: isoString.nullable(),
  last_alert_sell_regime: z.string().nullable(),
  last_alert_sell_score: z.number().nullable(),
  last_alert_buy_ts: isoString.nullable(),
  last_alert_buy_regime: z.string().nullable(),
  last_alert_buy_score: z.number().nullable(),
  last_score_breakdown: lastScoreBreakdownSchema.nullable(),
  quota_credits_today: z.number().int(),
});
export type AssetState = z.infer<typeof assetStateSchema>;

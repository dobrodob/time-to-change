/**
 * StateRepo — единственная точка доступа к D1. Все handlers/jobs работают
 * только через её методы; никаких raw SQL за её пределами.
 *
 * Все методы возвращают доменные типы (`User`, `BotState`, ...), валидированные
 * через zod при выходе D1 → защита от schema drift.
 *
 * D1 (SQLite) хранит boolean как INTEGER 0/1 — конвертим тут в JS boolean.
 */
import {
  type AlertRecord,
  type Asset,
  type AssetProvider,
  type AssetState,
  type AssetType,
  type BotState,
  type Conversion,
  type Direction,
  type Event,
  type LastScoreBreakdown,
  type Subscription,
  type User,
  type UserRole,
  alertRecordSchema,
  assetSchema,
  assetStateSchema,
  botStateSchema,
  lastScoreBreakdownSchema,
  subscriptionSchema,
  userSchema,
} from "./schema";

const intToBool = (n: unknown): boolean => n === 1;
const boolToInt = (b: boolean): number => (b ? 1 : 0);

interface UserRow {
  chat_id: number;
  role: string;
  name: string | null;
  joined_at: string;
  silence_active: number;
  silence_until: string | null;
  silence_reason: string | null;
  quiet_enabled: number;
  quiet_from_hour: number;
  quiet_to_hour: number;
  digest_enabled: number;
}

interface BotStateRow {
  schema_version: number;
  last_update_id: number;
  menu_set_at: string | null;
  menu_commands_count: number;
  last_digest_at: string | null;
  budget_target_eur: number | null;
  budget_deadline: string | null;
  budget_started_at: string | null;
  budget_converted_eur: number;
  budget_converted_usd: number;
}

function rowToUser(row: UserRow): User {
  return userSchema.parse({
    chat_id: row.chat_id,
    role: row.role,
    name: row.name,
    joined_at: row.joined_at,
    silence_active: intToBool(row.silence_active),
    silence_until: row.silence_until,
    silence_reason: row.silence_reason,
    quiet_enabled: intToBool(row.quiet_enabled),
    quiet_from_hour: row.quiet_from_hour,
    quiet_to_hour: row.quiet_to_hour,
    digest_enabled: intToBool(row.digest_enabled),
  });
}

function rowToBotState(row: BotStateRow): BotState {
  return botStateSchema.parse({
    schema_version: row.schema_version,
    last_update_id: row.last_update_id,
    menu_set_at: row.menu_set_at,
    menu_commands_count: row.menu_commands_count,
    last_digest_at: row.last_digest_at,
    budget_target_eur: row.budget_target_eur,
    budget_deadline: row.budget_deadline,
    budget_started_at: row.budget_started_at,
    budget_converted_eur: row.budget_converted_eur,
    budget_converted_usd: row.budget_converted_usd,
  });
}

export class StateRepo {
  constructor(private readonly db: D1Database) {}

  // ============ Users ============

  async getUser(chatId: number): Promise<User | null> {
    const row = await this.db
      .prepare("SELECT * FROM users WHERE chat_id = ?")
      .bind(chatId)
      .first<UserRow>();
    return row ? rowToUser(row) : null;
  }

  async getOwner(): Promise<User | null> {
    const row = await this.db
      .prepare("SELECT * FROM users WHERE role = 'owner' LIMIT 1")
      .first<UserRow>();
    return row ? rowToUser(row) : null;
  }

  async listUsers(): Promise<User[]> {
    const result = await this.db.prepare("SELECT * FROM users ORDER BY joined_at").all<UserRow>();
    return result.results.map(rowToUser);
  }

  async countUsers(): Promise<number> {
    const row = await this.db.prepare("SELECT COUNT(*) AS c FROM users").first<{ c: number }>();
    return row?.c ?? 0;
  }

  async addUser(input: {
    chat_id: number;
    role?: UserRole;
    name?: string | null;
    quiet_enabled?: boolean;
    quiet_from_hour?: number;
    quiet_to_hour?: number;
  }): Promise<User> {
    const role = input.role ?? "member";
    const joinedAt = new Date().toISOString();
    await this.db
      .prepare(
        `INSERT INTO users (chat_id, role, name, joined_at, quiet_enabled, quiet_from_hour, quiet_to_hour)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET
           name = COALESCE(users.name, excluded.name)`,
      )
      .bind(
        input.chat_id,
        role,
        input.name ?? null,
        joinedAt,
        boolToInt(input.quiet_enabled ?? false),
        input.quiet_from_hour ?? 23,
        input.quiet_to_hour ?? 7,
      )
      .run();
    const user = await this.getUser(input.chat_id);
    if (!user) throw new Error(`Failed to addUser ${input.chat_id}`);
    return user;
  }

  async removeUser(chatId: number): Promise<boolean> {
    const res = await this.db.prepare("DELETE FROM users WHERE chat_id = ?").bind(chatId).run();
    return (res.meta.changes ?? 0) > 0;
  }

  async updateUserSilence(
    chatId: number,
    active: boolean,
    until: string | null,
    reason: string | null,
  ): Promise<void> {
    await this.db
      .prepare(
        "UPDATE users SET silence_active = ?, silence_until = ?, silence_reason = ? WHERE chat_id = ?",
      )
      .bind(boolToInt(active), until, reason, chatId)
      .run();
  }

  async updateUserQuiet(
    chatId: number,
    enabled: boolean,
    fromHour: number,
    toHour: number,
  ): Promise<void> {
    await this.db
      .prepare(
        "UPDATE users SET quiet_enabled = ?, quiet_from_hour = ?, quiet_to_hour = ? WHERE chat_id = ?",
      )
      .bind(boolToInt(enabled), fromHour, toHour, chatId)
      .run();
  }

  async setDigestEnabled(chatId: number, enabled: boolean): Promise<void> {
    await this.db
      .prepare("UPDATE users SET digest_enabled = ? WHERE chat_id = ?")
      .bind(boolToInt(enabled), chatId)
      .run();
  }

  async expireSilencesIfDue(now: string): Promise<number> {
    const res = await this.db
      .prepare(
        `UPDATE users
         SET silence_active = 0, silence_until = NULL, silence_reason = NULL
         WHERE silence_active = 1 AND silence_until IS NOT NULL AND silence_until <= ?`,
      )
      .bind(now)
      .run();
    return res.meta.changes ?? 0;
  }

  // ============ Bot state (singleton) ============

  async getBotState(): Promise<BotState> {
    const row = await this.db.prepare("SELECT * FROM bot_state WHERE id = 1").first<BotStateRow>();
    if (!row) throw new Error("bot_state singleton missing — D1 schema not initialized");
    return rowToBotState(row);
  }

  /**
   * Атомарный max — защита от out-of-order webhook updates.
   */
  async updateLastUpdateId(updateId: number): Promise<void> {
    await this.db
      .prepare("UPDATE bot_state SET last_update_id = MAX(last_update_id, ?) WHERE id = 1")
      .bind(updateId)
      .run();
  }

  async setLastDigestAt(ts: string): Promise<void> {
    await this.db.prepare("UPDATE bot_state SET last_digest_at = ? WHERE id = 1").bind(ts).run();
  }

  async setMenuRegistered(setAt: string, count: number): Promise<void> {
    await this.db
      .prepare("UPDATE bot_state SET menu_set_at = ?, menu_commands_count = ? WHERE id = 1")
      .bind(setAt, count)
      .run();
  }

  // ============ Alert history ============

  async getRecentAlerts(limit: number): Promise<AlertRecord[]> {
    const result = await this.db
      .prepare(
        "SELECT ts, regime, score, rate, edge_pct, symbol, direction FROM alert_history ORDER BY ts DESC LIMIT ?",
      )
      .bind(limit)
      .all<{
        ts: string;
        regime: string;
        score: number;
        rate: number;
        edge_pct: number;
        symbol: string | null;
        direction: "buy" | "sell" | null;
      }>();
    return result.results.map((r) => alertRecordSchema.parse(r));
  }

  /**
   * Возвращает timestamp последнего алерта или null если истории нет.
   * Используется gating'ом для cooldown проверки.
   */
  async getLastAlertTs(): Promise<string | null> {
    const row = await this.db
      .prepare("SELECT ts FROM alert_history ORDER BY ts DESC LIMIT 1")
      .first<{ ts: string }>();
    return row?.ts ?? null;
  }

  // ============ Budget ============

  async setBudget(targetEur: number, deadline: string, startedAt: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE bot_state
         SET budget_target_eur = ?, budget_deadline = ?, budget_started_at = ?,
             budget_converted_eur = 0, budget_converted_usd = 0
         WHERE id = 1`,
      )
      .bind(targetEur, deadline, startedAt)
      .run();
    await this.db.prepare("DELETE FROM conversions").run();
  }

  async cancelBudget(): Promise<void> {
    await this.db
      .prepare(
        `UPDATE bot_state
         SET budget_target_eur = NULL, budget_deadline = NULL, budget_started_at = NULL,
             budget_converted_eur = 0, budget_converted_usd = 0
         WHERE id = 1`,
      )
      .run();
    await this.db.prepare("DELETE FROM conversions").run();
  }

  async addConversion(c: Conversion): Promise<void> {
    await this.db.batch([
      this.db
        .prepare("INSERT INTO conversions (ts, eur, rate, pct_at_alert) VALUES (?, ?, ?, ?)")
        .bind(c.ts, c.eur, c.rate, c.pct_at_alert),
      this.db
        .prepare(
          `UPDATE bot_state
           SET budget_converted_eur = budget_converted_eur + ?,
               budget_converted_usd = budget_converted_usd + ?
           WHERE id = 1`,
        )
        .bind(c.eur, c.eur * c.rate),
    ]);
  }

  /**
   * Удаляет последнюю запись из conversions + откатывает budget totals.
   * Atomic batch. Возвращает удалённую запись или null если history пуста.
   */
  async removeLastConversion(): Promise<Conversion | null> {
    const row = await this.db
      .prepare(
        "SELECT id, ts, eur, rate, pct_at_alert FROM conversions ORDER BY ts DESC, id DESC LIMIT 1",
      )
      .first<{ id: number; ts: string; eur: number; rate: number; pct_at_alert: number | null }>();
    if (!row) return null;
    await this.db.batch([
      this.db.prepare("DELETE FROM conversions WHERE id = ?").bind(row.id),
      this.db
        .prepare(
          `UPDATE bot_state
           SET budget_converted_eur = MAX(0, budget_converted_eur - ?),
               budget_converted_usd = MAX(0, budget_converted_usd - ?)
           WHERE id = 1`,
        )
        .bind(row.eur, row.eur * row.rate),
    ]);
    return {
      id: row.id,
      ts: row.ts,
      eur: row.eur,
      rate: row.rate,
      pct_at_alert: row.pct_at_alert,
    };
  }

  async listConversions(): Promise<Conversion[]> {
    const result = await this.db
      .prepare("SELECT id, ts, eur, rate, pct_at_alert FROM conversions ORDER BY ts")
      .all<{ id: number; ts: string; eur: number; rate: number; pct_at_alert: number | null }>();
    return result.results.map((r) => ({
      id: r.id,
      ts: r.ts,
      eur: r.eur,
      rate: r.rate,
      pct_at_alert: r.pct_at_alert,
    }));
  }

  // ============ Events (FOMC/ECB/NFP/CPI blackout) ============

  async getUpcomingEvent(afterTs: string): Promise<Event | null> {
    const row = await this.db
      .prepare("SELECT id, ts, type, description FROM events WHERE ts > ? ORDER BY ts LIMIT 1")
      .bind(afterTs)
      .first<{ id: number; ts: string; type: string; description: string | null }>();
    if (!row) return null;
    return { id: row.id, ts: row.ts, type: row.type, description: row.description };
  }

  async listEventsInRange(fromTs: string, toTs: string): Promise<Event[]> {
    const result = await this.db
      .prepare("SELECT id, ts, type, description FROM events WHERE ts BETWEEN ? AND ? ORDER BY ts")
      .bind(fromTs, toTs)
      .all<{ id: number; ts: string; type: string; description: string | null }>();
    return result.results.map((r) => ({
      id: r.id,
      ts: r.ts,
      type: r.type,
      description: r.description,
    }));
  }

  // ============ Assets (multi-asset registry) ============

  async getAsset(symbol: string): Promise<Asset | null> {
    const row = await this.db.prepare("SELECT * FROM assets WHERE symbol = ?").bind(symbol).first<{
      symbol: string;
      display_name: string;
      type: string;
      provider: string;
      currency: string;
      active: number;
      added_at: string;
    }>();
    if (!row) return null;
    return assetSchema.parse({ ...row, active: intToBool(row.active) });
  }

  async listAssets(): Promise<Asset[]> {
    const result = await this.db.prepare("SELECT * FROM assets ORDER BY symbol").all<{
      symbol: string;
      display_name: string;
      type: string;
      provider: string;
      currency: string;
      active: number;
      added_at: string;
    }>();
    return result.results.map((r) => assetSchema.parse({ ...r, active: intToBool(r.active) }));
  }

  async listActiveAssets(): Promise<Asset[]> {
    const result = await this.db
      .prepare("SELECT * FROM assets WHERE active = 1 ORDER BY symbol")
      .all<{
        symbol: string;
        display_name: string;
        type: string;
        provider: string;
        currency: string;
        active: number;
        added_at: string;
      }>();
    return result.results.map((r) => assetSchema.parse({ ...r, active: intToBool(r.active) }));
  }

  async upsertAsset(input: {
    symbol: string;
    display_name: string;
    type: AssetType;
    provider: AssetProvider;
    currency: string;
  }): Promise<Asset> {
    const addedAt = new Date().toISOString();
    // Создаём НЕактивным: актив переходит в active=1 только при подтверждённой
    // подписке (subscribeAndActivate). Иначе prompt без выбора направления плодил
    // вечно-активные активы-сироты, жгущие квоту. На конфликте active НЕ трогаем
    // (существующий активный — EUR/USD — остаётся активным).
    await this.db
      .prepare(
        `INSERT INTO assets (symbol, display_name, type, provider, currency, active, added_at)
         VALUES (?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT(symbol) DO UPDATE SET
           display_name = excluded.display_name`,
      )
      .bind(input.symbol, input.display_name, input.type, input.provider, input.currency, addedAt)
      .run();
    const asset = await this.getAsset(input.symbol);
    if (!asset) throw new Error(`upsertAsset failed for ${input.symbol}`);
    return asset;
  }

  /**
   * Атомарно: создаёт подписку + активирует актив. `db.batch` = транзакция D1 —
   * если worker крашнется между двумя statements, не остаётся inconsistent state
   * «подписка есть, актив inactive» (это давало бы тихую вечную «нет данных» для
   * подписчика, т.к. analyze берёт только active-активы). Тот же приём, что в
   * appendAlertForAsset. Идемпотентно (ON CONFLICT DO NOTHING).
   */
  async subscribeAndActivate(chatId: number, symbol: string, dir: Direction): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO subscriptions (chat_id, symbol, direction, subscribed_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(chat_id, symbol, direction) DO NOTHING`,
        )
        .bind(chatId, symbol, dir, new Date().toISOString()),
      this.db.prepare("UPDATE assets SET active = 1 WHERE symbol = ?").bind(symbol),
    ]);
  }

  async deactivateAssetIfOrphan(symbol: string): Promise<boolean> {
    const row = await this.db
      .prepare("SELECT COUNT(*) AS c FROM subscriptions WHERE symbol = ?")
      .bind(symbol)
      .first<{ c: number }>();
    if ((row?.c ?? 0) === 0) {
      await this.db.prepare("UPDATE assets SET active = 0 WHERE symbol = ?").bind(symbol).run();
      return true;
    }
    return false;
  }

  // ============ Subscriptions ============

  async listUserSubscriptions(chatId: number): Promise<Subscription[]> {
    const result = await this.db
      .prepare(
        "SELECT chat_id, symbol, direction, subscribed_at FROM subscriptions WHERE chat_id = ? ORDER BY subscribed_at",
      )
      .bind(chatId)
      .all<{ chat_id: number; symbol: string; direction: string; subscribed_at: string }>();
    return result.results.map((r) => subscriptionSchema.parse(r));
  }

  async listSubscribers(symbol: string, dir: Direction): Promise<Subscription[]> {
    const result = await this.db
      .prepare(
        "SELECT chat_id, symbol, direction, subscribed_at FROM subscriptions WHERE symbol = ? AND direction = ?",
      )
      .bind(symbol, dir)
      .all<{ chat_id: number; symbol: string; direction: string; subscribed_at: string }>();
    return result.results.map((r) => subscriptionSchema.parse(r));
  }

  async countUserSubscriptions(chatId: number): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) AS c FROM subscriptions WHERE chat_id = ?")
      .bind(chatId)
      .first<{ c: number }>();
    return row?.c ?? 0;
  }

  async getSubscription(
    chatId: number,
    symbol: string,
    dir: Direction,
  ): Promise<Subscription | null> {
    const row = await this.db
      .prepare(
        "SELECT chat_id, symbol, direction, subscribed_at FROM subscriptions WHERE chat_id = ? AND symbol = ? AND direction = ?",
      )
      .bind(chatId, symbol, dir)
      .first<{ chat_id: number; symbol: string; direction: string; subscribed_at: string }>();
    return row ? subscriptionSchema.parse(row) : null;
  }

  async addSubscription(chatId: number, symbol: string, dir: Direction): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO subscriptions (chat_id, symbol, direction, subscribed_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(chat_id, symbol, direction) DO NOTHING`,
      )
      .bind(chatId, symbol, dir, new Date().toISOString())
      .run();
  }

  async removeSubscription(chatId: number, symbol: string, dir: Direction): Promise<boolean> {
    const res = await this.db
      .prepare("DELETE FROM subscriptions WHERE chat_id = ? AND symbol = ? AND direction = ?")
      .bind(chatId, symbol, dir)
      .run();
    return (res.meta.changes ?? 0) > 0;
  }

  async removeAllSubscriptionsForSymbol(chatId: number, symbol: string): Promise<number> {
    const res = await this.db
      .prepare("DELETE FROM subscriptions WHERE chat_id = ? AND symbol = ?")
      .bind(chatId, symbol)
      .run();
    return res.meta.changes ?? 0;
  }

  // ============ Asset state ============

  async getAssetState(symbol: string): Promise<AssetState | null> {
    const row = await this.db
      .prepare("SELECT * FROM asset_state WHERE symbol = ?")
      .bind(symbol)
      .first<{
        symbol: string;
        baseline_rolling_median_30d: number | null;
        baseline_rolling_p90_90d: number | null;
        baseline_rolling_p10_90d: number | null;
        baseline_computed_at: string | null;
        last_alert_sell_ts: string | null;
        last_alert_sell_regime: string | null;
        last_alert_sell_score: number | null;
        last_alert_buy_ts: string | null;
        last_alert_buy_regime: string | null;
        last_alert_buy_score: number | null;
        last_score_breakdown_json: string | null;
        quota_credits_today: number;
      }>();
    if (!row) return null;
    return assetStateSchema.parse({
      symbol: row.symbol,
      baseline_rolling_median_30d: row.baseline_rolling_median_30d,
      baseline_rolling_p90_90d: row.baseline_rolling_p90_90d,
      baseline_rolling_p10_90d: row.baseline_rolling_p10_90d,
      baseline_computed_at: row.baseline_computed_at,
      last_alert_sell_ts: row.last_alert_sell_ts,
      last_alert_sell_regime: row.last_alert_sell_regime,
      last_alert_sell_score: row.last_alert_sell_score,
      last_alert_buy_ts: row.last_alert_buy_ts,
      last_alert_buy_regime: row.last_alert_buy_regime,
      last_alert_buy_score: row.last_alert_buy_score,
      last_score_breakdown: row.last_score_breakdown_json
        ? lastScoreBreakdownSchema.parse(JSON.parse(row.last_score_breakdown_json))
        : null,
      quota_credits_today: row.quota_credits_today,
    });
  }

  /**
   * Primary asset для legacy single-asset surfaces (digest, /status, /explain,
   * alert_done_pct callback, /budget done fallback). Сейчас hardcoded 'EUR/USD';
   * при будущем переходе на полностью multi-asset readers — удалить и заменить
   * на per-subscription state lookup.
   */
  async getPrimaryAssetState(): Promise<AssetState | null> {
    return this.getAssetState("EUR/USD");
  }

  async upsertAssetState(symbol: string): Promise<void> {
    await this.db
      .prepare("INSERT INTO asset_state (symbol) VALUES (?) ON CONFLICT(symbol) DO NOTHING")
      .bind(symbol)
      .run();
  }

  async setAssetBaseline(
    symbol: string,
    median: number,
    p90: number,
    p10: number,
    computedAt: string,
  ): Promise<void> {
    await this.upsertAssetState(symbol);
    await this.db
      .prepare(
        `UPDATE asset_state
         SET baseline_rolling_median_30d = ?, baseline_rolling_p90_90d = ?,
             baseline_rolling_p10_90d = ?, baseline_computed_at = ?
         WHERE symbol = ?`,
      )
      .bind(median, p90, p10, computedAt, symbol)
      .run();
  }

  async setAssetLastScoreBreakdown(symbol: string, breakdown: LastScoreBreakdown): Promise<void> {
    await this.upsertAssetState(symbol);
    await this.db
      .prepare("UPDATE asset_state SET last_score_breakdown_json = ? WHERE symbol = ?")
      .bind(JSON.stringify(breakdown), symbol)
      .run();
  }

  async setAssetLastAlert(
    symbol: string,
    dir: Direction,
    ts: string,
    regime: string,
    score: number,
  ): Promise<void> {
    await this.upsertAssetState(symbol);
    const tsCol = dir === "sell" ? "last_alert_sell_ts" : "last_alert_buy_ts";
    const regimeCol = dir === "sell" ? "last_alert_sell_regime" : "last_alert_buy_regime";
    const scoreCol = dir === "sell" ? "last_alert_sell_score" : "last_alert_buy_score";
    await this.db
      .prepare(
        `UPDATE asset_state SET ${tsCol} = ?, ${regimeCol} = ?, ${scoreCol} = ? WHERE symbol = ?`,
      )
      .bind(ts, regime, score, symbol)
      .run();
  }

  async bumpAssetQuota(symbol: string, delta: number): Promise<void> {
    await this.upsertAssetState(symbol);
    await this.db
      .prepare(
        "UPDATE asset_state SET quota_credits_today = quota_credits_today + ? WHERE symbol = ?",
      )
      .bind(delta, symbol)
      .run();
  }

  /**
   * Суточный сброс quota_credits_today по всем активам (cron `1 0 * * *`,
   * синхронно с UTC-циклом сброса квоты TwelveData). Без этого счётчик копился
   * с cut-over без обнуления — `quota_credits_today`/`/health` показывали lifetime
   * вместо «за сегодня». Возвращает число обнулённых строк.
   */
  async resetAllQuota(): Promise<number> {
    const res = await this.db
      .prepare("UPDATE asset_state SET quota_credits_today = 0 WHERE quota_credits_today != 0")
      .run();
    return res.meta.changes ?? 0;
  }

  /**
   * SUM(quota_credits_today) across all asset_state rows — для /health endpoint.
   * Заменяет bot_state.quota_credits_used_today (удалён в migration 0005).
   */
  async getTotalAssetQuotaToday(): Promise<number> {
    const row = await this.db
      .prepare("SELECT COALESCE(SUM(quota_credits_today), 0) AS total FROM asset_state")
      .first<{ total: number }>();
    return row?.total ?? 0;
  }

  /**
   * Append alert с symbol + direction. Также обновляет asset_state.last_alert_*.
   * Атомарно через db.batch — если CF Worker крашется посередине, не остаётся
   * inconsistent state (raw alert без обновлённого last_alert_* для cooldown
   * gate'а).
   */
  async appendAlertForAsset(symbol: string, dir: Direction, alert: AlertRecord): Promise<void> {
    const tsCol = dir === "sell" ? "last_alert_sell_ts" : "last_alert_buy_ts";
    const regimeCol = dir === "sell" ? "last_alert_sell_regime" : "last_alert_buy_regime";
    const scoreCol = dir === "sell" ? "last_alert_sell_score" : "last_alert_buy_score";
    await this.db.batch([
      this.db
        .prepare(
          "INSERT INTO alert_history (ts, regime, score, rate, edge_pct, symbol, direction) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(alert.ts, alert.regime, alert.score, alert.rate, alert.edge_pct, symbol, dir),
      this.db
        .prepare("INSERT INTO asset_state (symbol) VALUES (?) ON CONFLICT(symbol) DO NOTHING")
        .bind(symbol),
      this.db
        .prepare(
          `UPDATE asset_state SET ${tsCol} = ?, ${regimeCol} = ?, ${scoreCol} = ? WHERE symbol = ?`,
        )
        .bind(alert.ts, alert.regime, alert.score, symbol),
    ]);
  }

  /**
   * Алерты подписок user'а — JOIN alert_history × subscriptions.
   */
  async getRecentAlertsForUser(
    chatId: number,
    limit: number,
  ): Promise<Array<AlertRecord & { symbol: string; direction: Direction }>> {
    const result = await this.db
      .prepare(
        `SELECT DISTINCT h.ts, h.regime, h.score, h.rate, h.edge_pct, h.symbol, h.direction
         FROM alert_history h
         JOIN subscriptions s ON s.symbol = h.symbol AND s.direction = h.direction
         WHERE s.chat_id = ?
         ORDER BY h.ts DESC
         LIMIT ?`,
      )
      .bind(chatId, limit)
      .all<{
        ts: string;
        regime: string;
        score: number;
        rate: number;
        edge_pct: number;
        symbol: string;
        direction: string;
      }>();
    return result.results.map((r) => ({
      ts: r.ts,
      regime: r.regime,
      score: r.score,
      rate: r.rate,
      edge_pct: r.edge_pct,
      symbol: r.symbol,
      direction: r.direction as Direction,
    }));
  }
}

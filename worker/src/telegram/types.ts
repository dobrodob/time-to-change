/**
 * Telegram Bot API types + parsed domain types.
 *
 * Минимальный набор: Update / Message / CallbackQuery — only fields,
 * которые реально используются handlers'ами. Полный API не нужен.
 *
 * Все типы из callback_data парсера живут здесь как domain output —
 * никаких pydantic-style runtime validators, чисто типы (parser сам
 * проверяет structure).
 */

// ============ Telegram API (incoming webhook payload) ============

export interface TelegramUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
}

export interface TelegramMessage {
  message_id: number;
  date: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

// ============ Parsed commands ============

export type CommandKind =
  | "start"
  | "help"
  | "status"
  | "silence"
  | "resume"
  | "whoami"
  | "invite"
  | "users"
  | "leave"
  | "budget"
  | "budget_done"
  | "budget_cancel"
  | "budget_undo"
  | "quiet"
  | "digest"
  | "explain"
  | "history"
  | "subscribe"
  | "unsubscribe"
  | "assets"
  | "unknown";

export interface ParsedCommand {
  kind: CommandKind;
  /** Duration в **секундах** (для /silence). null если не применимо. */
  duration: number | null;
  /** Целевой chat_id для /invite. */
  target_chat_id: number | null;
  /** Параметры /budget. */
  budget_target_eur: number | null;
  budget_days: number | null;
  budget_done_eur: number | null;
  budget_done_rate: number | null;
  /** Параметры /quiet. */
  quiet_from: number | null;
  quiet_to: number | null;
  quiet_off: boolean;
  /** /digest on/off. null = просто show. */
  digest_on: boolean | null;
  /** Symbol для /subscribe и /unsubscribe (uppercase). null если не задан. */
  asset_symbol: string | null;
  /** Direction для /subscribe (опционально, если user указал в одну команду). */
  asset_direction: "buy" | "sell" | null;
}

// ============ Parsed callbacks ============

export type CallbackKind = "alert_done_pct" | "alert_silence" | "subscribe" | "unknown";

export interface ParsedCallback {
  kind: CallbackKind;
  pct: number | null;
  /** Duration в **секундах**. */
  duration: number | null;
  /** Для subscribe callback: symbol + direction. */
  asset_symbol: string | null;
  asset_direction: "buy" | "sell" | null;
}

// ============ Helpers ============

/** Дефолтная длительность /silence — 7 days в секундах. */
export const DEFAULT_SILENCE_SECONDS = 7 * 24 * 3600;
/** Максимум для /silence — 30 days в секундах. Дольше — clamp. */
export const MAX_SILENCE_SECONDS = 30 * 24 * 3600;

/** Конструктор дефолтного ParsedCommand с kind. Все остальные поля = null/false. */
export function emptyCommand(kind: CommandKind): ParsedCommand {
  return {
    kind,
    duration: null,
    target_chat_id: null,
    budget_target_eur: null,
    budget_days: null,
    budget_done_eur: null,
    budget_done_rate: null,
    quiet_from: null,
    quiet_to: null,
    quiet_off: false,
    digest_on: null,
    asset_symbol: null,
    asset_direction: null,
  };
}

/** Конструктор дефолтного ParsedCallback. */
export function emptyCallback(kind: CallbackKind): ParsedCallback {
  return { kind, pct: null, duration: null, asset_symbol: null, asset_direction: null };
}

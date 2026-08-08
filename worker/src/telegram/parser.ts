/**
 * Port of `src/telegram_io/commands.py`. Pure-функция, никаких side effects.
 * Parity verified via tests/parity/parser.test.ts (37 commands + 15 callbacks).
 */
import {
  DEFAULT_SILENCE_SECONDS,
  MAX_SILENCE_SECONDS,
  type ParsedCallback,
  type ParsedCommand,
  emptyCallback,
  emptyCommand,
} from "./types";

// Регулярки — точный порт Python, case-insensitive где Python имеет re.IGNORECASE.
const PERIOD_RE = /^\s*(\d{1,3})\s*([hdw])\s*$/i;
const BUDGET_RE = /^\s*(\d{1,7}(?:\.\d+)?)\s+(\d{1,3})d?\s*$/i;
const BUDGET_DONE_RE = /^\s*done\s+(\d{1,7}(?:\.\d+)?)(?:\s+(\d+(?:\.\d+)?))?\s*$/i;
const QUIET_RE = /^\s*(\d{1,2})\s+(\d{1,2})\s*$/;
const CHAT_ID_RE = /^-?\d{1,15}$/;

/**
 * Парсит timedelta из строки: "7d", "3h", "2w". Returns seconds или null.
 */
function parsePeriod(arg: string): number | null {
  const match = arg.match(PERIOD_RE);
  if (!match) return null;
  const n = Number.parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  if (n <= 0) return null;
  if (unit === "h") return n * 3600;
  if (unit === "d") return n * 24 * 3600;
  if (unit === "w") return n * 7 * 24 * 3600;
  return null;
}

function parseBudget(arg: string): ParsedCommand {
  const lower = arg.toLowerCase();
  if (!arg || lower === "show") {
    return emptyCommand("budget");
  }
  if (lower === "cancel" || lower === "off" || lower === "stop") {
    return emptyCommand("budget_cancel");
  }
  if (lower === "undo") {
    return emptyCommand("budget_undo");
  }

  if (lower.startsWith("done")) {
    const match = arg.match(BUDGET_DONE_RE);
    if (!match) return emptyCommand("unknown");
    const eur = Number.parseFloat(match[1]);
    const rate = match[2] ? Number.parseFloat(match[2]) : null;
    if (eur <= 0) return emptyCommand("unknown");
    return {
      ...emptyCommand("budget_done"),
      budget_done_eur: eur,
      budget_done_rate: rate,
    };
  }

  const match = arg.match(BUDGET_RE);
  if (!match) return emptyCommand("unknown");
  const target = Number.parseFloat(match[1]);
  const days = Number.parseInt(match[2], 10);
  if (target <= 0 || days <= 0 || days > 365) return emptyCommand("unknown");
  return {
    ...emptyCommand("budget"),
    budget_target_eur: target,
    budget_days: days,
  };
}

function parseQuiet(arg: string): ParsedCommand {
  const lower = arg.toLowerCase();
  if (!arg || lower === "show") {
    return emptyCommand("quiet");
  }
  if (lower === "off" || lower === "disable" || lower === "stop") {
    return { ...emptyCommand("quiet"), quiet_off: true };
  }
  const match = arg.match(QUIET_RE);
  if (!match) return emptyCommand("unknown");
  const f = Number.parseInt(match[1], 10);
  const t = Number.parseInt(match[2], 10);
  if (f < 0 || f > 23 || t < 0 || t > 23) return emptyCommand("unknown");
  return { ...emptyCommand("quiet"), quiet_from: f, quiet_to: t };
}

function parseAssetSymbol(
  arg: string,
): { symbol: string; direction: "buy" | "sell" | null } | null {
  // "AAPL" / "LKOH" / "EUR/USD" / "BTC/USD" / "AAPL buy" / "EUR/USD sell"
  const trimmed = arg.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/\s+/);
  const symbol = parts[0].toUpperCase();
  // Validate basic symbol format: 1-12 chars, A-Z 0-9 / -
  if (!/^[A-Z0-9/\-]{1,12}$/.test(symbol)) return null;
  let direction: "buy" | "sell" | null = null;
  if (parts.length > 1) {
    const dirArg = parts[1].toLowerCase();
    if (dirArg === "buy" || dirArg === "купить" || dirArg === "покупать") {
      direction = "buy";
    } else if (dirArg === "sell" || dirArg === "продать" || dirArg === "продавать") {
      direction = "sell";
    }
  }
  return { symbol, direction };
}

function parseSubscribe(arg: string): ParsedCommand {
  if (!arg) return emptyCommand("subscribe"); // no symbol — show help menu в handler
  const parsed = parseAssetSymbol(arg);
  if (!parsed) return emptyCommand("unknown");
  return {
    ...emptyCommand("subscribe"),
    asset_symbol: parsed.symbol,
    asset_direction: parsed.direction,
  };
}

function parseUnsubscribe(arg: string): ParsedCommand {
  if (!arg) return emptyCommand("unsubscribe"); // no symbol — show prompt
  const parsed = parseAssetSymbol(arg);
  if (!parsed) return emptyCommand("unknown");
  return {
    ...emptyCommand("unsubscribe"),
    asset_symbol: parsed.symbol,
    asset_direction: parsed.direction,
  };
}

function parseDigest(arg: string): ParsedCommand {
  const lower = arg.toLowerCase();
  if (lower === "" || lower === "show") {
    return emptyCommand("digest");
  }
  if (lower === "on" || lower === "enable") {
    return { ...emptyCommand("digest"), digest_on: true };
  }
  if (lower === "off" || lower === "disable") {
    return { ...emptyCommand("digest"), digest_on: false };
  }
  return emptyCommand("unknown");
}

/**
 * Парсит Telegram-команду из текста сообщения.
 * Возвращает `ParsedCommand` с kind="unknown" для всего непонятного.
 */
export function parseCommand(text: string): ParsedCommand {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return emptyCommand("unknown");
  }

  // text.split(maxsplit=1) → JS: первое whitespace и остаток
  const spaceIdx = trimmed.search(/\s/);
  const rawCmd = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const arg = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx).trim();
  // Strip @BotName suffix: /start@MyBot → /start
  const cmd = rawCmd.toLowerCase().split("@", 1)[0];

  switch (cmd) {
    case "/start":
      return emptyCommand("start");
    case "/help":
      return emptyCommand("help");
    case "/resume":
      return emptyCommand("resume");
    case "/whoami":
      return emptyCommand("whoami");
    case "/users":
      return emptyCommand("users");
    case "/leave":
      return emptyCommand("leave");
    case "/history":
      return emptyCommand("history");
    case "/assets":
      return emptyCommand("assets");
  }

  // /status [SYMBOL] и /explain [SYMBOL] — опциональный symbol для multi-asset
  if (cmd === "/status") {
    if (!arg) return emptyCommand("status");
    const parsed = parseAssetSymbol(arg);
    if (!parsed) return emptyCommand("unknown");
    return { ...emptyCommand("status"), asset_symbol: parsed.symbol };
  }
  if (cmd === "/explain") {
    if (!arg) return emptyCommand("explain");
    const parsed = parseAssetSymbol(arg);
    if (!parsed) return emptyCommand("unknown");
    return { ...emptyCommand("explain"), asset_symbol: parsed.symbol };
  }

  if (cmd === "/subscribe") {
    return parseSubscribe(arg);
  }
  if (cmd === "/unsubscribe") {
    return parseUnsubscribe(arg);
  }

  if (cmd === "/silence") {
    if (!arg) {
      return { ...emptyCommand("silence"), duration: DEFAULT_SILENCE_SECONDS };
    }
    let duration = parsePeriod(arg);
    if (duration === null) return emptyCommand("unknown");
    if (duration > MAX_SILENCE_SECONDS) duration = MAX_SILENCE_SECONDS;
    return { ...emptyCommand("silence"), duration };
  }

  if (cmd === "/invite") {
    if (!arg || !CHAT_ID_RE.test(arg)) return emptyCommand("unknown");
    return { ...emptyCommand("invite"), target_chat_id: Number.parseInt(arg, 10) };
  }

  if (cmd === "/budget") return parseBudget(arg);
  if (cmd === "/quiet") return parseQuiet(arg);
  if (cmd === "/digest") return parseDigest(arg);
  if (cmd === "/undo") {
    // Alias для /budget undo — quick одна команда для fix последнего misclick.
    return emptyCommand("budget_undo");
  }

  return emptyCommand("unknown");
}

/**
 * Парсит callback_data inline-кнопки: "b:done:30", "b:sil:7d".
 */
export function parseCallback(data: string): ParsedCallback {
  const parts = data.split(":");
  if (parts.length < 2 || parts[0] !== "b") {
    return emptyCallback("unknown");
  }

  if (parts[1] === "done" && parts.length === 3) {
    const pct = Number.parseInt(parts[2], 10);
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
      return emptyCallback("unknown");
    }
    return { ...emptyCallback("alert_done_pct"), pct };
  }

  if (parts[1] === "sil" && parts.length === 3) {
    const duration = parsePeriod(parts[2]);
    if (duration === null || duration > MAX_SILENCE_SECONDS) {
      return emptyCallback("unknown");
    }
    return { ...emptyCallback("alert_silence"), duration };
  }

  // sub:SYMBOL:DIR — для inline confirmation подписки.
  // (Different prefix чем "b:" — split first part by lifting.)
  return emptyCallback("unknown");
}

/**
 * Parse callback. Handles обе формы:
 *   - "b:done:30" / "b:sil:7d" — alert buttons
 *   - "sub:AAPL:buy" / "sub:LKOH:sell" — subscribe confirmation
 */
export function parseCallbackV2(data: string): ParsedCallback {
  const parts = data.split(":");
  if (parts[0] === "b") return parseCallback(data);
  if (parts[0] === "sub" && parts.length === 3) {
    const symbol = parts[1].toUpperCase();
    const dir = parts[2];
    if (!/^[A-Z0-9/\-]{1,12}$/.test(symbol)) return emptyCallback("unknown");
    if (dir !== "buy" && dir !== "sell") return emptyCallback("unknown");
    return {
      ...emptyCallback("subscribe"),
      asset_symbol: symbol,
      asset_direction: dir,
    };
  }
  return emptyCallback("unknown");
}

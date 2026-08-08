import { isMarketOpenForType } from "../analyze/market-calendar";
import {
  type Regime,
  type ScoreBreakdown,
  historicalWindowFor,
  weightsFor,
} from "../analyze/scoring";
import { type PacingSnapshot, computePacing } from "../budget/pacing";
import type {
  Asset,
  AssetState,
  AssetType,
  BotState,
  Direction,
  Subscription,
  User,
} from "../state/schema";
import { scoreBreakdownForDirection } from "../state/schema";
/**
 * Форматирование Telegram-сообщений (HTML parse_mode).
 * Port of src/alerts/formatter.py — 30+ функций для всех команд + alerts + digest.
 *
 * Принципы:
 * - Естественный русский язык
 * - Показываем только активные состояния (без "silence не активен")
 * - regime отображается как «ждать / наблюдать / частичное окно / сильное окно»
 */
import type { InlineKeyboard } from "../telegram/api";
import type { BotCommand } from "../telegram/api";

// ============ Меню Telegram (для setMyCommands) ============

export const TELEGRAM_MENU_COMMANDS: BotCommand[] = [
  { command: "assets", description: "Мои подписки и их текущие оценки" },
  { command: "subscribe", description: "Подписаться: EUR/USD, AAPL, BTC/USD, XAU/USD..." },
  { command: "unsubscribe", description: "Отписаться: /unsubscribe SYMBOL" },
  { command: "status", description: "Резонность: /status (все) или /status SYMBOL" },
  { command: "explain", description: "Детали оценки: /explain или /explain SYMBOL" },
  { command: "history", description: "Последние 10 алертов" },
  { command: "budget", description: "Бюджет владельца (EUR/USD): /budget 6000 30d" },
  { command: "undo", description: "Владелец: отменить последнюю запись обмена" },
  { command: "silence", description: "Заглушить (по умолч 7d)" },
  { command: "resume", description: "Включить уведомления" },
  { command: "quiet", description: "Тихие часы: /quiet 23 7" },
  { command: "digest", description: "Утренний дайджест" },
  { command: "help", description: "Список команд" },
];

const REGIME_LABEL: Record<Regime, string> = {
  cooldown: "ждать",
  watch: "наблюдать",
  partial: "частичное окно",
  strong: "сильное окно",
};

const REGIME_EMOJI: Record<Regime, string> = {
  cooldown: "⏸",
  watch: "👀",
  partial: "💱",
  strong: "🚀",
};

const REGIME_DEFAULT_PCT: Record<Regime, number> = {
  cooldown: 0,
  watch: 0,
  partial: 30,
  strong: 50,
};

/** Escape untrusted/provider-controlled text before using Telegram HTML mode. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const PRESSURE_RU: Record<string, string> = {
  ahead: "опережаешь график",
  on_track: "идёшь по графику",
  behind: "отстаёшь от графика",
  critical: "⚠ мало времени",
};

const MONTHS_RU: Record<number, string> = {
  1: "января",
  2: "февраля",
  3: "марта",
  4: "апреля",
  5: "мая",
  6: "июня",
  7: "июля",
  8: "августа",
  9: "сентября",
  10: "октября",
  11: "ноября",
  12: "декабря",
};

// ============ Local time formatters ============

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  shortTz: string;
}

function getLocalParts(iso: string, tzName = "Europe/Madrid"): LocalParts {
  const date = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tzName,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const getValue = (type: string) =>
    Number.parseInt(parts.find((p) => p.type === type)?.value ?? "0", 10);
  const hour = getValue("hour") % 24; // Intl gives 24 for midnight
  return {
    year: getValue("year"),
    month: getValue("month"),
    day: getValue("day"),
    hour,
    minute: getValue("minute"),
    shortTz: tzName.split("/").pop() ?? tzName,
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** `HH:MM Madrid` — короткий формат для inline-показа. */
export function formatLocal(iso: string, tzName = "Europe/Madrid"): string {
  const p = getLocalParts(iso, tzName);
  return `${pad(p.hour)}:${pad(p.minute)} ${p.shortTz}`;
}

/** `YYYY-MM-DD HH:MM Madrid` — полная дата для логов. */
export function formatLocalFull(iso: string, tzName = "Europe/Madrid"): string {
  const p = getLocalParts(iso, tzName);
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)} ${p.shortTz}`;
}

/** `8 июня` — для дат без времени. */
export function formatDate(iso: string, tzName = "Europe/Madrid"): string {
  const p = getLocalParts(iso, tzName);
  return `${p.day} ${MONTHS_RU[p.month]}`;
}

// ============ Plural helpers ============

function pluralDays(n: number): string {
  if (n % 100 >= 11 && n % 100 <= 14) return "дней";
  const last = n % 10;
  if (last === 1) return "день";
  if (last >= 2 && last <= 4) return "дня";
  return "дней";
}

// ============ Budget helpers ============

function budgetRemaining(state: BotState): number {
  if (state.budget_target_eur === null) return 0;
  return Math.max(0, state.budget_target_eur - state.budget_converted_eur);
}

function budgetAverageRate(state: BotState): number | null {
  if (state.budget_converted_eur <= 0) return null;
  return state.budget_converted_usd / state.budget_converted_eur;
}

function renderBudgetBlock(
  state: BotState,
  pacing: PacingSnapshot,
  tzName = "Europe/Madrid",
): string {
  const pressureLabel = PRESSURE_RU[pacing.pressure] ?? pacing.pressure;
  const target = state.budget_target_eur ?? 0;
  const deadlineStr = state.budget_deadline ? formatDate(state.budget_deadline, tzName) : "?";
  const daysLeft = Math.max(1, Math.round(pacing.days_left));
  const daysWord = pluralDays(daysLeft);
  const daily = pacing.daily_target_eur;
  const remaining = budgetRemaining(state);
  const lines = [
    `💼 <b>Бюджет:</b> ${state.budget_converted_eur.toFixed(0)} / ${target.toFixed(0)} EUR`,
    `   осталось <b>${remaining.toFixed(0)} EUR</b> · ${daysLeft} ${daysWord} до ${deadlineStr}`,
    `   ${pressureLabel} · цель ${daily.toFixed(0)} EUR/день`,
  ];
  const avg = budgetAverageRate(state);
  if (avg !== null) {
    lines[lines.length - 1] += ` · средний rate ${avg.toFixed(5)}`;
  }
  return lines.join("\n");
}

// ============ /status ============

/**
 * Лаконичный /status по конкретному ассету.
 *
 * - `asset=null` (legacy backward compat): печатает «Курс EUR/USD» и
 *   forex-форматирование 1.17833.
 * - `asset` указан: печатает display_name (SYMBOL) и currency-aware цену
 *   через formatPrice (₽5,420.50 / $185.30 / 1.17833).
 *
 * `baseline_rolling_*` пороги имеют разный смысл для sell vs buy directions —
 * для sell показываем верх (p90), для buy — низ (p10). По умолчанию (без asset)
 * показываем p90 (legacy EUR/USD sell).
 */
export function formatStatus(
  assetState: AssetState | null,
  user: User | null,
  tzName = "Europe/Madrid",
  asset: Asset | null = null,
): string {
  const last = assetState?.last_score_breakdown ?? null;
  const header = asset
    ? `<b>${escapeHtml(asset.display_name)} (${escapeHtml(asset.symbol)})</b>`
    : "<b>Курс EUR/USD</b>";
  const lines: string[] = [header, ""];

  if (last !== null) {
    const priceStr = asset ? formatPrice(last.rate, asset.currency) : last.rate.toFixed(5);
    lines.push(`Курс: <b>${priceStr}</b> (на ${formatLocal(last.ts, tzName)})`);
  } else {
    lines.push("Свежие данные ещё не загружены.");
  }
  const fmtBaseline = (v: number) => (asset ? formatPrice(v, asset.currency) : v.toFixed(5));
  if (assetState?.baseline_rolling_median_30d != null) {
    lines.push(`Медиана 30d: ${fmtBaseline(assetState.baseline_rolling_median_30d)}`);
  }
  if (assetState?.baseline_rolling_p90_90d != null) {
    lines.push(`Верх 90d: ${fmtBaseline(assetState.baseline_rolling_p90_90d)}`);
  }
  if (assetState?.baseline_rolling_p10_90d != null) {
    lines.push(`Низ 90d: ${fmtBaseline(assetState.baseline_rolling_p10_90d)}`);
  }
  if (last !== null) {
    const edgeSign = last.edge_pct >= 0 ? "+" : "";
    lines.push(`Edge: <b>${edgeSign}${last.edge_pct.toFixed(2)}%</b>`);
    const regimeRu = escapeHtml(REGIME_LABEL[last.regime as Regime] ?? last.regime);
    lines.push("");
    lines.push(`Резонность: <b>${last.score.toFixed(0)}/100</b> — ${regimeRu}`);
  }

  if (user?.silence_active && user.silence_until !== null) {
    lines.push("");
    lines.push(`🔇 Silence до ${formatLocal(user.silence_until, tzName)}`);
  }

  return lines.join("\n");
}

/**
 * /status без аргумента + есть подписки: компактный overview всех подписок
 * с full breakdown по каждой (price, score, regime, edge).
 */
export function formatStatusOverview(
  subs: Subscription[],
  assets: Record<string, Asset>,
  states: Record<string, AssetState | null>,
  user: User | null,
  tzName = "Europe/Madrid",
): string {
  if (subs.length === 0) {
    return (
      "<b>У тебя нет подписок.</b>\n\n" +
      "Подпишись через /subscribe &lt;тикер&gt;, например:\n" +
      "• /subscribe EUR/USD\n" +
      "• /subscribe XAU/USD (золото)\n" +
      "• /subscribe AAPL"
    );
  }
  const lines = [`<b>Статус по подпискам (${subs.length})</b>`, ""];
  for (const s of subs) {
    const asset = assets[s.symbol];
    if (!asset) {
      // Orphan subscription — asset был deactivated/удалён. Не молчим, иначе
      // юзер не поймёт почему его подписка не в списке.
      lines.push(
        `⚠️ <b>${escapeHtml(s.symbol)}</b> — ассет снят с анализа (отпишись через /unsubscribe)`,
      );
      continue;
    }
    const state = states[s.symbol] ?? null;
    const last = scoreBreakdownForDirection(state, s.direction);
    const typeEmoji = TYPE_EMOJI[asset.type] ?? "•";
    const dirEmoji = DIR_EMOJI[s.direction];
    if (last === null) {
      lines.push(
        `${typeEmoji} <b>${escapeHtml(asset.symbol)}</b> · ${dirEmoji} ${DIR_LABEL[s.direction]} · нет данных`,
      );
      continue;
    }
    const price = formatPrice(last.rate, asset.currency);
    const regime = escapeHtml(REGIME_LABEL[last.regime as Regime] ?? last.regime);
    const edgeSign = last.edge_pct >= 0 ? "+" : "";
    lines.push(
      `${typeEmoji} <b>${escapeHtml(asset.symbol)}</b> · ${dirEmoji} ${DIR_LABEL[s.direction]}`,
    );
    lines.push(
      `   ${price} · <b>${last.score.toFixed(0)}/100</b> ${regime} · edge ${edgeSign}${last.edge_pct.toFixed(2)}%`,
    );
  }
  lines.push("");
  lines.push("Подробнее: <code>/status SYMBOL</code> или <code>/explain SYMBOL</code>");

  if (user?.silence_active && user.silence_until !== null) {
    lines.push("");
    lines.push(`🔇 Silence до ${formatLocal(user.silence_until, tzName)}`);
  }
  return lines.join("\n");
}

/** Сообщение когда юзер сделал /status SYMBOL для символа, на который не подписан. */
export function formatStatusNotSubscribed(symbol: string): string {
  const safeSymbol = escapeHtml(symbol);
  return `<code>${safeSymbol}</code> пока не в реестре ассетов.\n\nВозможны варианты:\n• Опечатка — посмотри список своих подписок через /assets\n• Хочешь подписаться: <code>/subscribe ${safeSymbol}</code>\n  (после первого analyze, в течение часа, появятся данные)`;
}

/** Сообщение когда asset помечен active=false (снят с анализа). */
export function formatStatusAssetInactive(asset: Asset): string {
  const symbol = escapeHtml(asset.symbol);
  return `<b>${escapeHtml(asset.display_name)} (${symbol})</b>\n\n⏸ Этот ассет временно снят с анализа (никто на него не подписан).\nЕсли хочешь возобновить — <code>/subscribe ${symbol}</code>.`;
}

/** Сообщение когда есть asset в registry но ещё нет analyze data. */
export function formatStatusNoData(asset: Asset): string {
  return `<b>${escapeHtml(asset.display_name)} (${escapeHtml(asset.symbol)})</b>\n\nСвежие данные ещё не загружены — analyze запускается раз в час.\nЗайди через ~час или подожди ближайшего alert.`;
}

// ============ /alert ============

export interface AlertContext {
  asset: Asset;
  direction: Direction;
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  RUB: "₽",
  USD: "$",
  EUR: "€",
  GBP: "£",
  JPY: "¥",
  CNY: "¥",
};

function formatPrice(rate: number, currency: string): string {
  const symbol = CURRENCY_SYMBOLS[currency] ?? "";
  // Smart decimals по magnitude: forex pairs (rate < 10) — 5 знаков, остальное
  // (stocks, commodity, crypto, индексы — rate ≥ 10) — 2 знака.
  // USD/JPY и подобные JPY-кроссы (rate ~110) попадут в 2 знака — acceptable
  // для отображения (precision потеря не критична).
  const decimals = Math.abs(rate) < 10 ? 5 : 2;
  return symbol
    ? `${symbol}${rate.toFixed(decimals)}`
    : `${rate.toFixed(decimals)} ${escapeHtml(currency)}`;
}

export function formatAlert(
  breakdown: ScoreBreakdown,
  edgePct: number,
  nowIso: string,
  state: BotState,
  tzName = "Europe/Madrid",
  ctx?: AlertContext,
): string {
  const regime = breakdown.regime;
  const emoji = REGIME_EMOJI[regime];
  const when = formatLocal(nowIso, tzName);
  const notesLines = breakdown.notes.map((n) => `• ${escapeHtml(n)}`).join("\n");
  const edgeSign = edgePct >= 0 ? "+" : "";

  // Header: для legacy EUR/USD без ctx сохраняем старую формулировку; иначе
  // используем asset name + direction.
  let header: string;
  let recommendationText: string | null = null;
  if (ctx) {
    const verb = ctx.direction === "sell" ? "продать" : "купить";
    header = `${emoji} <b>${escapeHtml(ctx.asset.display_name)} (${escapeHtml(ctx.asset.symbol)}) — окно для ${ctx.direction === "sell" ? "продажи" : "покупки"}</b>`;
    if (ctx.direction === "sell") {
      const recPct = REGIME_DEFAULT_PCT[regime];
      if (recPct > 0) {
        recommendationText = `Рекомендация: ${verb} около <b>${recPct}%</b> позиции`;
      }
    } else {
      const recPct = REGIME_DEFAULT_PCT[regime];
      if (recPct > 0) {
        recommendationText = `Рекомендация: добавить около <b>${recPct}%</b> к позиции`;
      }
    }
  } else {
    header = `${emoji} <b>EUR/USD — окно для обмена</b>`;
  }

  const price = ctx ? formatPrice(breakdown.rate, ctx.asset.currency) : breakdown.rate.toFixed(5);
  const parts = [
    header,
    "",
    `Цена: <b>${price}</b> (на ${when})`,
    `Резонность: <b>${breakdown.score.toFixed(0)}/100</b> (${REGIME_LABEL[regime]})`,
    `Edge над 30d: <b>${edgeSign}${edgePct.toFixed(2)}%</b>`,
    "",
    notesLines,
    "",
  ];

  // EUR/USD только — show budget block. Для других assets — generic recommendation.
  if (!ctx || ctx.asset.symbol === "EUR/USD") {
    const pacing = computePacing(state, nowIso);
    if (pacing !== null && state.budget_target_eur !== null) {
      const recPct = pacing.suggested_pct;
      const remaining = budgetRemaining(state);
      const recEur = (remaining * recPct) / 100;
      const recUsd = recEur * breakdown.rate;
      parts.push(renderBudgetBlock(state, pacing, tzName));
      parts.push("");
      parts.push(
        `Рекомендация: <b>${recPct}%</b> остатка ≈ ${recEur.toFixed(0)} EUR ≈ ${recUsd.toFixed(0)} USD`,
      );
    } else if (!ctx) {
      const recPct = REGIME_DEFAULT_PCT[regime];
      if (recPct > 0) {
        parts.push(`Рекомендация: поменять около <b>${recPct}%</b> свободных EUR`);
      }
    } else if (recommendationText) {
      parts.push(recommendationText);
    }
  } else if (recommendationText) {
    parts.push(recommendationText);
  }

  return parts.join("\n");
}

export function alertInlineKeyboard(
  breakdown: ScoreBreakdown,
  state: BotState,
  nowIso: string,
  ctx?: AlertContext,
  options: { includeConversionActions?: boolean } = {},
): InlineKeyboard {
  const pacing = computePacing(state, nowIso);
  let primaryPct: number;
  let secondaryPct: number;
  if (pacing !== null && state.budget_target_eur !== null) {
    primaryPct = pacing.suggested_pct;
    secondaryPct = Math.max(20, Math.min(80, primaryPct - 20));
  } else {
    primaryPct = REGIME_DEFAULT_PCT[breakdown.regime];
    secondaryPct = Math.max(20, primaryPct - 20);
  }

  // Для member-аудитории и не-EUR/USD assets кнопки done не имеют смысла.
  if (options.includeConversionActions === false || (ctx && ctx.asset.symbol !== "EUR/USD")) {
    return [
      [
        { text: "Заглушить 1d", callback_data: "b:sil:1d" },
        { text: "Заглушить 7d", callback_data: "b:sil:7d" },
      ],
    ];
  }

  const eurRemaining = state.budget_target_eur !== null ? budgetRemaining(state) : null;
  const btnLabel = (pct: number) => {
    if (eurRemaining !== null && eurRemaining > 0) {
      return `Поменял ${pct}% (~${((eurRemaining * pct) / 100).toFixed(0)} EUR)`;
    }
    return `Поменял ${pct}%`;
  };

  return [
    [
      { text: btnLabel(primaryPct), callback_data: `b:done:${primaryPct}` },
      { text: btnLabel(secondaryPct), callback_data: `b:done:${secondaryPct}` },
    ],
    [
      { text: "Заглушить 1d", callback_data: "b:sil:1d" },
      { text: "Заглушить 7d", callback_data: "b:sil:7d" },
    ],
  ];
}

// ============ Multi-asset commands ============

const TYPE_EMOJI: Record<string, string> = {
  forex: "💱",
  stock_us: "🇺🇸",
  stock_ru: "🇷🇺",
  crypto: "₿",
  commodity: "🥇",
  index: "📊",
};

const TYPE_LABEL: Record<string, string> = {
  forex: "Forex",
  stock_us: "US-акция",
  stock_ru: "RU-акция",
  crypto: "Crypto",
  commodity: "Commodity",
  index: "Index",
};

const DIR_LABEL: Record<Direction, string> = {
  sell: "продажа",
  buy: "покупка",
};

const DIR_EMOJI: Record<Direction, string> = {
  sell: "💰",
  buy: "🛒",
};

/**
 * /subscribe SYMBOL — после resolveSymbol показывает confirmation prompt с inline buttons.
 */
export function formatSubscribePrompt(asset: Asset, currentPrice: number | null): string {
  const typeLabel = TYPE_LABEL[asset.type] ?? asset.type;
  const typeEmoji = TYPE_EMOJI[asset.type] ?? "•";
  const priceLine =
    currentPrice !== null ? `\nТекущая цена: ${formatPrice(currentPrice, asset.currency)}` : "";
  return `${typeEmoji} <b>${escapeHtml(asset.display_name)}</b> (${escapeHtml(asset.symbol)})\n${typeLabel} · валюта ${escapeHtml(asset.currency)}${priceLine}\n\nНа что подписать?`;
}

export function subscribePromptKeyboard(symbol: string): InlineKeyboard {
  return [
    [
      { text: "🛒 Покупать (когда дёшево)", callback_data: `sub:${symbol}:buy` },
      { text: "💰 Продавать (когда дорого)", callback_data: `sub:${symbol}:sell` },
    ],
  ];
}

export function formatSubscribed(asset: Asset, dir: Direction): string {
  const verb = dir === "sell" ? "когда цена близка к пику" : "когда цена близка к дну";
  return (
    `✅ Подписан на ${escapeHtml(asset.display_name)} (${escapeHtml(asset.symbol)}) — ${DIR_LABEL[dir]}.\n` +
    `Алерт придёт ${verb} (score ≥75) — но не чаще раза в 24 часа.`
  );
}

export function formatAlreadySubscribed(asset: Asset, dir: Direction): string {
  return `Уже подписан на ${escapeHtml(asset.symbol)} ${DIR_LABEL[dir]}. /assets — список подписок.`;
}

export function formatSubscribeNotFound(symbol: string): string {
  return `Символ <code>${escapeHtml(symbol)}</code> не найден ни у TwelveData, ни у MOEX.\n\n<b>Примеры подписок:</b>\n• Forex: <code>/subscribe EUR/USD</code>, <code>/subscribe GBP/USD</code>\n• Commodity: <code>/subscribe XAU/USD</code> (золото), <code>/subscribe XAG/USD</code> (серебро)\n• US-акции: <code>/subscribe AAPL</code>, <code>/subscribe TSLA</code>, <code>/subscribe NVDA</code>\n• RU-акции: <code>/subscribe LKOH</code>, <code>/subscribe GAZP</code>, <code>/subscribe SBER</code>\n• Crypto: <code>/subscribe BTC/USD</code>, <code>/subscribe ETH/USD</code>`;
}

export function formatSubscribeLimit(currentCount: number, maxCount: number): string {
  return `У тебя уже ${currentCount} подписок (макс ${maxCount}). Отпишись от чего-то через /unsubscribe.`;
}

export function formatUnsubscribed(asset: Asset, removed: number): string {
  if (removed === 0) {
    return `Не был подписан на ${escapeHtml(asset.symbol)}.`;
  }
  return `❎ Отписан от ${escapeHtml(asset.display_name)} (${escapeHtml(asset.symbol)}).`;
}

/**
 * /assets — компактный список всех подписок user'а с current state.
 */
export function formatUserAssets(
  subs: Subscription[],
  assets: Record<string, Asset>,
  states: Record<string, AssetState | null>,
): string {
  if (subs.length === 0) {
    return (
      "<b>У тебя нет подписок.</b>\n\n" +
      "Подпишись через /subscribe &lt;тикер&gt;:\n" +
      "• Forex: /subscribe EUR/USD, /subscribe GBP/USD\n" +
      "• US-акции: /subscribe AAPL, /subscribe TSLA, /subscribe NVDA\n" +
      "• RU-акции: /subscribe LKOH, /subscribe GAZP, /subscribe SBER, /subscribe YDEX\n" +
      "• Crypto: /subscribe BTC/USD, /subscribe ETH/USD"
    );
  }
  const lines = [`<b>Твои подписки (${subs.length}):</b>`, ""];
  for (const s of subs) {
    const asset = assets[s.symbol];
    if (!asset) continue;
    const state = states[s.symbol] ?? null;
    const last = scoreBreakdownForDirection(state, s.direction);
    const typeEmoji = TYPE_EMOJI[asset.type] ?? "•";
    const dirEmoji = DIR_EMOJI[s.direction];
    const price = last !== null ? formatPrice(last.rate, asset.currency) : "—";
    const score = last !== null ? `${last.score.toFixed(0)}/100` : "—";
    const regime =
      last !== null ? escapeHtml(REGIME_LABEL[last.regime as Regime] ?? last.regime) : "—";
    lines.push(
      `${typeEmoji} <b>${escapeHtml(asset.symbol)}</b> · ${dirEmoji} ${DIR_LABEL[s.direction]} · ${price} · ${score} (${regime})`,
    );
  }
  lines.push("");
  lines.push("Управление: /subscribe &lt;тикер&gt;, /unsubscribe &lt;тикер&gt;");
  return lines.join("\n");
}

// ============ /explain ============

export function formatExplain(
  assetState: AssetState | null,
  tzName = "Europe/Madrid",
  asset: Asset | null = null,
): string {
  const last = assetState?.last_score_breakdown ?? null;
  if (last === null) {
    return "Анализ ещё не запускался — попробуй через час.";
  }

  // Per-asset веса (Q3 PR #27): forex по дефолту, остальные типы — свои профили.
  // Без asset (legacy /explain без аргумента) — forex defaults. С asset →
  // weightsFor(asset.type) + historicalWindowFor(asset.type) согласованно с
  // analyze/job.ts computeScore(..., asset.type). Без этого таблица показывает
  // неверные веса для stock_us/stock_ru/crypto/index (бы лгала юзеру).
  const weights = weightsFor(asset?.type);
  const histWindow = historicalWindowFor(asset?.type);
  const weightMap: Array<[string, string, number]> = [
    ["trend_daily", "Дневной тренд", weights.trend_daily],
    ["timing_hourly", "Часовой тайминг", weights.timing_hourly],
    ["extremes", "Экстремумы", weights.extremes],
    ["volatility", "Волатильность", weights.volatility],
    ["historical", `Историка (${histWindow}d)`, weights.historical],
  ];
  const when = formatLocal(last.ts, tzName);
  const regimeRu = escapeHtml(REGIME_LABEL[last.regime as Regime] ?? last.regime);
  const edgeSign = last.edge_pct >= 0 ? "+" : "";
  const priceStr = asset ? formatPrice(last.rate, asset.currency) : last.rate.toFixed(5);
  const header = asset
    ? `<b>Из чего оценка ${escapeHtml(asset.symbol)}</b> — ${when}`
    : `<b>Из чего сейчас оценка</b> — ${when}`;

  const lines = [
    header,
    "",
    `Курс: <b>${priceStr}</b> · Edge: <b>${edgeSign}${last.edge_pct.toFixed(2)}%</b>`,
    "",
  ];
  let total = 0;
  for (const [key, label, weight] of weightMap) {
    const value = last.components[key];
    if (value === null || value === undefined) {
      lines.push(`• ${label}: нет данных`);
      continue;
    }
    const contrib = value * weight;
    total += contrib;
    lines.push(
      `• ${label}: <b>${value.toFixed(0)}/100</b> × ${weight.toFixed(2)} = <b>${contrib.toFixed(1)}</b>`,
    );
  }
  lines.push("");
  lines.push(`Итого: <b>${total.toFixed(0)}/100</b> — ${regimeRu}`);

  if (last.notes.length > 0) {
    lines.push("");
    lines.push("<b>Что повлияло:</b>");
    for (const n of last.notes) lines.push(`• ${escapeHtml(n)}`);
  }
  if (!last.was_alert && last.gate_reason) {
    lines.push("");
    lines.push(`<i>Алерт не отправлен: ${escapeHtml(last.gate_reason)}</i>`);
  }

  return lines.join("\n");
}

// ============ /digest ============

export function formatDigest(
  state: BotState,
  breakdown: ScoreBreakdown | null,
  edgePct: number | null,
  dailyEdgePct: number | null,
  nowIso: string,
  tzName = "Europe/Madrid",
  multiAssetSummary: string | null = null,
  primaryDirection: Direction | null = null,
): string {
  const when = formatLocal(nowIso, tzName);
  const lines = [`☕ <b>Утро, ${when}</b>`, ""];

  if (breakdown !== null) {
    const regimeRu = REGIME_LABEL[breakdown.regime];
    const directionLabel =
      primaryDirection === null
        ? ""
        : ` · ${DIR_EMOJI[primaryDirection]} ${DIR_LABEL[primaryDirection]}`;
    lines.push(`Курс EUR/USD${directionLabel}: <b>${breakdown.rate.toFixed(5)}</b>`);
    if (dailyEdgePct !== null) {
      const sign = dailyEdgePct >= 0 ? "+" : "";
      lines.push(`Edge за день: <b>${sign}${dailyEdgePct.toFixed(2)}%</b>`);
    }
    if (edgePct !== null) {
      const sign = edgePct >= 0 ? "+" : "";
      lines.push(`Edge за месяц: <b>${sign}${edgePct.toFixed(2)}%</b>`);
    }
    lines.push(`Резонность: <b>${breakdown.score.toFixed(0)}/100</b> — ${regimeRu}`);
  } else {
    lines.push("Свежих данных EUR/USD нет (рынок закрыт).");
  }

  if (state.budget_target_eur !== null) {
    const pacing = computePacing(state, nowIso);
    if (pacing !== null) {
      lines.push("");
      lines.push(renderBudgetBlock(state, pacing, tzName));
    }
  }

  if (multiAssetSummary !== null) {
    lines.push("");
    lines.push(multiAssetSummary);
  }

  return lines.join("\n");
}

// Порог «протухших» данных в дайджесте — выровнен с freshness-монитором (2ч):
// analyze hourly, >2ч при ОТКРЫТОМ рынке = фид лёг (особенно актуально для
// металлов на бесплатном Yahoo, который flaky). Не выдаём старый срез за курс.
const DIGEST_STALE_THRESHOLD_SECONDS = 2 * 3600;

function isStaleDuringMarket(lastTs: string, type: AssetType, now: string): boolean {
  if (!isMarketOpenForType(type, now)) return false; // рынок закрыт — staleness ожидаема
  return (Date.parse(now) - Date.parse(lastTs)) / 1000 > DIGEST_STALE_THRESHOLD_SECONDS;
}

/**
 * Compact summary не-EUR/USD подписок для appending к digest. Возвращает null
 * если у юзера нет non-EUR/USD подписок (тогда digest остаётся forex-only).
 *
 * При открытом рынке проверяет свежесть last.ts: протухший срез (analyze не
 * отработал, напр. транзиентный сбой Yahoo) рендерится как «нет свежих данных»,
 * а не как актуальная цена — иначе юзер принял бы решение по старому курсу.
 */
export function formatDigestMultiAssetSummary(
  subs: Subscription[],
  assets: Record<string, Asset>,
  states: Record<string, AssetState | null>,
  now: string,
): string | null {
  const nonEurUsd = subs.filter((s) => s.symbol !== "EUR/USD");
  if (nonEurUsd.length === 0) return null;

  const lines = ["📊 <b>Прочие подписки:</b>"];
  for (const s of nonEurUsd) {
    const asset = assets[s.symbol];
    if (!asset) {
      lines.push(`⚠️ ${escapeHtml(s.symbol)} — снят с анализа`);
      continue;
    }
    const state = states[s.symbol] ?? null;
    const last = scoreBreakdownForDirection(state, s.direction);
    const typeEmoji = TYPE_EMOJI[asset.type] ?? "•";
    const dirEmoji = DIR_EMOJI[s.direction];
    if (last === null) {
      lines.push(`${typeEmoji} ${escapeHtml(asset.symbol)} · ${dirEmoji} — нет данных`);
      continue;
    }
    if (isStaleDuringMarket(last.ts, asset.type, now)) {
      lines.push(`${typeEmoji} ${escapeHtml(asset.symbol)} · ${dirEmoji} — нет свежих данных`);
      continue;
    }
    const price = formatPrice(last.rate, asset.currency);
    const regime = escapeHtml(REGIME_LABEL[last.regime as Regime] ?? last.regime);
    lines.push(
      `${typeEmoji} <b>${escapeHtml(asset.symbol)}</b> · ${dirEmoji} ${price} · ${last.score.toFixed(0)}/100 (${regime})`,
    );
  }
  return lines.join("\n");
}

// ============ /history ============

/**
 * Список последних N алертов (regime/score/edge/timestamp + symbol для multi-asset).
 * Если history пустая — короткое info-сообщение.
 */
export function formatHistory(
  alerts: Array<{
    ts: string;
    regime: string;
    score: number;
    rate: number;
    edge_pct: number;
    symbol?: string | null;
    direction?: "buy" | "sell" | null;
  }>,
  tzName = "Europe/Madrid",
): string {
  if (alerts.length === 0) {
    return "История пуста. Алерты появятся когда курс достигнет partial+ (score ≥75) и пройдёт gating.";
  }
  const word = pluralAlerts(alerts.length);
  const lines = [`<b>Последние ${alerts.length} ${word}</b>`, ""];
  for (const a of alerts) {
    const regimeRu = escapeHtml(REGIME_LABEL[a.regime as Regime] ?? a.regime);
    const emoji = REGIME_EMOJI[a.regime as Regime] ?? "•";
    const edgeSign = a.edge_pct >= 0 ? "+" : "";
    // Multi-asset alerts (post-12.05) имеют symbol; legacy EUR/USD до cut-over — нет.
    const symbolPart = a.symbol ? ` ${escapeHtml(a.symbol)}` : "";
    const dirPart = a.direction ? ` ${DIR_EMOJI[a.direction]}` : "";
    // Rate formatting: forex (rate<10) — 5 знаков, остальное 2.
    const rateStr = Math.abs(a.rate) < 10 ? a.rate.toFixed(5) : a.rate.toFixed(2);
    lines.push(
      `${emoji}${dirPart}${symbolPart} ${formatLocal(a.ts, tzName)} · <b>${rateStr}</b> · ${a.score.toFixed(0)}/100 (${regimeRu}) · edge ${edgeSign}${a.edge_pct.toFixed(2)}%`,
    );
  }
  return lines.join("\n");
}

function pluralAlerts(n: number): string {
  if (n % 100 >= 11 && n % 100 <= 14) return "алертов";
  const last = n % 10;
  if (last === 1) return "алерт";
  if (last >= 2 && last <= 4) return "алерта";
  return "алертов";
}

// ============ Help / system ============

export function formatHelp(role: "owner" | "member" = "owner"): string {
  const common = `<b>Команды</b>

<b>Подписки на активы</b>
/subscribe SYMBOL — подписаться (forex, акции, crypto, commodity)
  • Forex: EUR/USD, GBP/USD
  • US-акции: AAPL, TSLA, NVDA
  • RU-акции: LKOH, GAZP, SBER
  • Crypto: BTC/USD, ETH/USD
  • Commodity: XAU/USD (золото), XAG/USD (серебро)
/unsubscribe SYMBOL — отписаться
/assets — мои подписки одним списком

<b>Анализ</b>
/status — обзор всех подписок (price/score/regime/edge)
/status SYMBOL — детально по одной подписке
/explain — детальная разбивка оценки
/explain SYMBOL — разбивка по конкретному ассету
/history — последние 10 алертов по твоим подпискам

<b>Уведомления</b>
/silence [период] — заглушить (1h, 3d, 2w; по умолч 7d)
/resume — снять silence
/quiet 23 7 — тихие часы
/digest on|off — утренний дайджест

<b>Аккаунт</b>
/leave — ${role === "owner" ? "недоступно владельцу" : "удалить себя из бота"}
`;
  if (role !== "owner") return common;
  return `${common}\n<b>Владелец · бюджет EUR/USD</b>
/budget 6000 30d — поставить цель
/budget done 1500 1.0852 — записать обмен
/budget — показать прогресс
/undo — отменить последнюю запись
/budget cancel — снять
/users — кто пользуется ботом
`;
}

export function formatSilenceSet(untilIso: string, tzName = "Europe/Madrid"): string {
  return `🔇 Silence до ${formatLocalFull(untilIso, tzName)}`;
}

export function formatResume(): string {
  return "🔔 Уведомления включены";
}

export function formatUnknown(): string {
  return "Неизвестная команда. /help — список.";
}

export function formatStart(): string {
  return (
    "Привет 👋\n\n" +
    "Я отслеживаю курсы forex, акций (US + Россия), commodity (золото, серебро) и crypto. " +
    "Пишу когда момент выгоден для покупки или продажи.\n\n" +
    "<b>Подпишись на интересные активы:</b>\n" +
    "/subscribe EUR/USD — Евро/Доллар\n" +
    "/subscribe XAU/USD — Золото\n" +
    "/subscribe AAPL — Apple\n" +
    "/subscribe LKOH — Лукойл\n" +
    "/subscribe BTC/USD — Биткоин\n\n" +
    "После /subscribe выберешь: <b>покупать</b> (когда дёшево) или <b>продавать</b> (когда дорого).\n\n" +
    "/help — все команды\n" +
    "/assets — мои подписки"
  );
}

export function formatWhoami(chatId: number): string {
  return `Твой chat_id: <code>${chatId}</code>`;
}

export function formatInvited(chatId: number, name: string | null): string {
  return `✅ Добавлен: ${name ?? `chat_id ${chatId}`}`;
}

export function formatInviteAlreadyMember(chatId: number): string {
  return `chat_id ${chatId} уже подписан`;
}

export function formatInviteNotify(ownerName: string | null): string {
  const by = ownerName ? ` от ${escapeHtml(ownerName)}` : "";
  return `✅ Тебя добавили в EUR/USD bot${by}.\nАлерты будут приходить автоматически.\n\n/help — список команд.`;
}

export function formatInviteSelf(): string {
  return "Себя приглашать не нужно :)";
}

export function formatUsersList(users: User[]): string {
  if (users.length === 0) return "Никого не подписано.";
  const lines = ["<b>Подписаны:</b>", ""];
  for (const u of users) {
    const marker = u.role === "owner" ? "👑" : "👤";
    const name = u.name ? escapeHtml(u.name) : `chat_id ${u.chat_id}`;
    let flags = "";
    if (u.silence_active) flags += " 🔇";
    if (u.quiet_enabled) flags += " 🌙";
    lines.push(`${marker} ${name}${flags}`);
  }
  return lines.join("\n");
}

export function formatLeft(): string {
  return "Удалил тебя из бота.";
}

export function formatOwnerOnly(): string {
  return "Эта команда только для владельца.";
}

export function formatOwnerCannotLeave(): string {
  return "Владелец не может удалить себя командой /leave — иначе управление экземпляром останется без владельца.";
}

// ============ Budget messages ============

export function formatBudgetSet(state: BotState, tzName = "Europe/Madrid"): string {
  const target = state.budget_target_eur ?? 0;
  const deadlineStr = state.budget_deadline ? formatDate(state.budget_deadline, tzName) : "?";
  const now = state.budget_started_at ?? new Date().toISOString();
  const pacing = computePacing(state, now);
  const daily = pacing?.daily_target_eur ?? 0;
  return `💼 Бюджет: <b>${target.toFixed(0)} EUR</b> до ${deadlineStr}\nВ среднем нужно ≈ <b>${daily.toFixed(0)} EUR/день</b>\n\nПосле обмена нажимай кнопки в алертах или /budget done 1500 1.0852`;
}

export function formatBudgetShow(
  state: BotState,
  conversions: Array<{ ts: string; eur: number; rate: number }>,
  nowIso: string,
  tzName = "Europe/Madrid",
): string {
  if (state.budget_target_eur === null) {
    return "Бюджет не установлен. /budget 6000 30d — поставить.";
  }
  const pacing = computePacing(state, nowIso);
  if (pacing === null) {
    return "Бюджет повреждён. /budget cancel и заново.";
  }
  const lines = [renderBudgetBlock(state, pacing, tzName)];
  if (conversions.length > 0) {
    lines.push("");
    lines.push("<b>История:</b>");
    for (const h of conversions.slice(-10)) {
      const ts = formatLocal(h.ts, tzName);
      lines.push(
        `• ${ts}: ${h.eur.toFixed(0)} EUR @ ${h.rate.toFixed(5)} = ${(h.eur * h.rate).toFixed(0)} USD`,
      );
    }
  }
  return lines.join("\n");
}

export function formatBudgetDone(state: BotState, eur: number, rate: number): string {
  const lines = [`✅ ${eur.toFixed(0)} EUR @ ${rate.toFixed(5)} = ${(eur * rate).toFixed(0)} USD`];
  if (state.budget_target_eur !== null && budgetRemaining(state) <= 0) {
    lines.push("🎉 Бюджет закрыт целиком!");
  } else if (state.budget_target_eur !== null) {
    lines.push(`Осталось: <b>${budgetRemaining(state).toFixed(0)} EUR</b>`);
  }
  const avg = budgetAverageRate(state);
  if (avg !== null) lines.push(`Средний rate: ${avg.toFixed(5)}`);
  return lines.join("\n");
}

export function formatBudgetCancel(): string {
  return "💼 Бюджет снят";
}

export function formatBudgetNoActive(): string {
  return "Бюджет не установлен. /budget 6000 30d сначала.";
}

/** Подтверждение отмены последней conversion. */
export function formatBudgetUndo(
  removed: { ts: string; eur: number; rate: number } | null,
  remainingEur: number,
  tzName = "Europe/Madrid",
): string {
  if (removed === null) {
    return "Истории обменов нет — отменять нечего.";
  }
  const when = formatLocal(removed.ts, tzName);
  return (
    `↩️ Отменил: ${removed.eur.toFixed(0)} EUR @ ${removed.rate.toFixed(5)} (от ${when})\n` +
    `Осталось: <b>${remainingEur.toFixed(0)} EUR</b>`
  );
}

// ============ Quiet / digest ============

export function formatQuietSet(fromH: number, toH: number, tzName = "Europe/Madrid"): string {
  const shortTz = tzName.split("/").pop() ?? tzName;
  return `🌙 Тихие часы: ${pad(fromH)}:00 – ${pad(toH)}:00 ${shortTz}`;
}

export function formatQuietOff(): string {
  return "🔔 Тихие часы отключены";
}

export function formatQuietShow(user: User | null, tzName = "Europe/Madrid"): string {
  if (user === null || !user.quiet_enabled) {
    return "Тихие часы не настроены. /quiet 23 7 — включить.";
  }
  const shortTz = tzName.split("/").pop() ?? tzName;
  return `🌙 Тихие часы: ${pad(user.quiet_from_hour)}:00 – ${pad(user.quiet_to_hour)}:00 ${shortTz}`;
}

export function formatDigestShow(user: User | null): string {
  if (user === null) return "Не подписан на бот.";
  const state = user.digest_enabled ? "включён" : "выключен";
  return `📰 Утренний дайджест ${state}`;
}

export function formatDigestSet(
  enabled: boolean,
  hour = 11,
  minute = 42,
  tzName = "Europe/Madrid",
): string {
  if (enabled) {
    const shortTz = tzName.split("/").pop() ?? tzName;
    return `📰 Утренний дайджест включён (~${pad(hour)}:${pad(minute)} ${shortTz})`;
  }
  return "📰 Утренний дайджест выключен";
}

// ============ Callback responses ============

export function formatCallbackDone(eur: number, rate: number, pct: number): string {
  return `✅ ${pct}% = ${eur.toFixed(0)} EUR @ ${rate.toFixed(5)} = ${(eur * rate).toFixed(0)} USD`;
}

export function formatCallbackDoneNoBudget(pct: number): string {
  return `Записал ~${pct}%. Чтобы вести точный учёт: /budget 6000 30d`;
}

export function formatCallbackSilenced(periodLabel: string): string {
  return `🔇 Silence на ${periodLabel}`;
}

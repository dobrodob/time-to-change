/**
 * Command handlers (webhook → repo mutation → reply).
 * Port of src/cli/commands.py:_handle_update + helpers.
 *
 * Dispatch вызывается из telegram/webhook.ts. Каждый handler получает
 * Env + StateRepo + TelegramClient + ParsedCommand/Callback и
 * непосредственно выполняет действие (mutate D1 + send reply).
 *
 * Errors не пробрасываются: telegram blocked → swallowed, prevent broadcast
 * взрыв. Auth errors (401) — fail-loud (выше catch'нется и upgraded to 5xx).
 */
import { computeEdgePct } from "../analyze/gating";
import { resolveSymbolAuto } from "../analyze/providers";
import type { ValidatedEnv } from "../env";
import { log } from "../lib/log";
import { nowIso } from "../lib/time";
import type { StateRepo } from "../state/repo";
import type { Asset, AssetState, User } from "../state/schema";
import { TelegramAuthError, TelegramBlockedError, type TelegramClient } from "../telegram/api";
import type {
  ParsedCallback,
  ParsedCommand,
  TelegramCallbackQuery,
  TelegramMessage,
} from "../telegram/types";
import {
  TELEGRAM_MENU_COMMANDS,
  formatAlreadySubscribed,
  formatBudgetCancel,
  formatBudgetDone,
  formatBudgetNoActive,
  formatBudgetSet,
  formatBudgetShow,
  formatBudgetUndo,
  formatCallbackDone,
  formatCallbackDoneNoBudget,
  formatCallbackSilenced,
  formatDigestSet,
  formatDigestShow,
  formatExplain,
  formatHelp,
  formatHistory,
  formatLeft,
  formatQuietOff,
  formatQuietSet,
  formatQuietShow,
  formatResume,
  formatSilenceSet,
  formatStart,
  formatStatus,
  formatStatusAssetInactive,
  formatStatusNoData,
  formatStatusNotSubscribed,
  formatStatusOverview,
  formatSubscribeLimit,
  formatSubscribeNotFound,
  formatSubscribePrompt,
  formatSubscribed,
  formatUnknown,
  formatUnsubscribed,
  formatUserAssets,
  formatUsersList,
  formatWhoami,
  subscribePromptKeyboard,
} from "./formatter";

const TZ = "Europe/Madrid";
// Refresh menu every day — было 7, но при изменении описаний без изменения
// количества команд (например после multi-asset polish PR #26) старые
// descriptions висят в Telegram-клиентах юзеров неделю. 1 день — компромисс
// между API spam и свежестью без миграции для menu_fingerprint column.
const MENU_REFRESH_DAYS = 1;
const MAX_SUBSCRIPTIONS_PER_USER = 10;
// Hard safety net: TwelveData free tier = 800 calls/day, ~16 unique assets max.
// При попытке subscribe на новый actив beyond limit — explicit error с upgrade path.
const MAX_ACTIVE_ASSETS_GLOBAL = 15;
const DEFAULT_DIGEST_HOUR = 11;
const DEFAULT_DIGEST_MINUTE = 42;

// ============ Helpers ============

/** Безопасный send: TelegramBlockedError свертаем, всё прочее пробрасываем. */
async function safeSend(tg: TelegramClient, chatId: number, text: string): Promise<void> {
  try {
    await tg.sendMessage(chatId, text);
  } catch (err) {
    if (err instanceof TelegramAuthError) throw err;
    if (err instanceof TelegramBlockedError) {
      log("warn", "telegram_blocked", { chat_id: chatId });
      return;
    }
    log("error", "telegram_send_failed", { chat_id: chatId, error: String(err).slice(0, 200) });
  }
}

/** Регистрирует Telegram-меню если устарело или изменилось. */
async function ensureMenu(repo: StateRepo, tg: TelegramClient): Promise<void> {
  const state = await repo.getBotState();
  const now = new Date();
  const expectedCount = TELEGRAM_MENU_COMMANDS.length;
  if (state.menu_set_at !== null) {
    const last = new Date(state.menu_set_at).getTime();
    const ageDays = (now.getTime() - last) / 86400_000;
    if (ageDays < MENU_REFRESH_DAYS && state.menu_commands_count === expectedCount) {
      return;
    }
  }
  try {
    await tg.setMyCommands(TELEGRAM_MENU_COMMANDS);
    await repo.setMenuRegistered(now.toISOString(), expectedCount);
    log("info", "telegram_menu_updated", { count: expectedCount });
  } catch (err) {
    log("warn", "telegram_menu_failed", { error: String(err).slice(0, 200) });
  }
}

function periodLabel(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  return `${seconds}s`;
}

// ============ Message dispatch ============

/**
 * Обрабатывает входящий message-update. Возвращает ничего; всё через safeSend и repo.
 */
export async function dispatchMessage(
  env: ValidatedEnv,
  repo: StateRepo,
  tg: TelegramClient,
  message: TelegramMessage,
  cmd: ParsedCommand,
): Promise<void> {
  // Менюшку обновляем lazy при первом message — не на каждом ping.
  await ensureMenu(repo, tg);

  const chatId = message.chat.id;
  const senderName = formatSenderName(message);

  // Expire any due silences first
  await repo.expireSilencesIfDue(nowIso());

  let user = await repo.getUser(chatId);

  // === Open access: auto-register любого нового user'а как member ===
  // (Раньше: только owner-capture при первом /start, остальные игнорились.)
  // Сейчас: любая команда от незарегистрированного → создаём member, отвечаем
  // welcome'ом + help'ом если /start, иначе обрабатываем команду как обычно.
  if (user === null) {
    // Первый owner всё ещё может быть полезен для аналитики (e.g. кто запустил
    // бот). Если ещё нет owner — даём первому user'у role=owner; иначе member.
    const owner = await repo.getOwner();
    const role = owner === null ? "owner" : "member";
    user = await repo.addUser({ chat_id: chatId, role, name: senderName });
    log("info", "user_registered", { chat_id: chatId, role, name: senderName });
    if (cmd.kind === "start") {
      // Welcome + help, дальше не обрабатываем (он только что зашёл).
      await safeSend(tg, chatId, formatStart());
      await safeSend(tg, chatId, formatHelp(role));
      return;
    }
    // Не /start — продолжаем dispatch ниже, теперь как зарегистрированный.
  }

  // Зарегистрированный — обрабатываем command по kind.
  switch (cmd.kind) {
    case "start":
      await safeSend(tg, chatId, formatStart());
      await safeSend(tg, chatId, formatHelp(user.role));
      return;

    case "help":
      await safeSend(tg, chatId, formatHelp(user.role));
      return;

    case "status":
      await handleStatus(repo, tg, user, cmd);
      return;

    case "explain":
      await handleExplain(repo, tg, user, cmd);
      return;

    case "history": {
      const alerts = await repo.getRecentAlerts(10);
      await safeSend(tg, chatId, formatHistory(alerts, TZ));
      return;
    }

    case "subscribe":
      await handleSubscribe(env, repo, tg, user, cmd);
      return;

    case "unsubscribe":
      await handleUnsubscribe(env, repo, tg, user, cmd);
      return;

    case "assets":
      await handleAssets(repo, tg, user);
      return;

    case "silence":
      await handleSilence(tg, repo, user, cmd, chatId);
      return;

    case "resume":
      await repo.updateUserSilence(chatId, false, null, null);
      await safeSend(tg, chatId, formatResume());
      return;

    case "whoami":
      await safeSend(tg, chatId, formatWhoami(chatId));
      return;

    case "invite":
      // Deprecated в open-access режиме: invites больше не нужны.
      await safeSend(
        tg,
        chatId,
        "Инвайты больше не нужны 🎉\n" +
          "Любой может стартовать бот: пусть твой друг напишет /start этому боту.",
      );
      return;

    case "users":
      // Public list: можно увидеть кто пользуется (без contact info).
      await safeSend(tg, chatId, formatUsersList(await repo.listUsers()));
      return;

    case "leave":
      // Любой user может уйти (включая owner — теперь это не критично).
      await repo.removeUser(chatId);
      await safeSend(tg, chatId, formatLeft());
      return;

    case "budget":
      await handleBudget(tg, repo, user, cmd);
      return;

    case "budget_done":
      await handleBudgetDone(tg, repo, user, cmd);
      return;

    case "budget_cancel":
      await repo.cancelBudget();
      await safeSend(tg, chatId, formatBudgetCancel());
      return;

    case "budget_undo": {
      const removed = await repo.removeLastConversion();
      const state = await repo.getBotState();
      const remaining =
        state.budget_target_eur !== null
          ? Math.max(0, state.budget_target_eur - state.budget_converted_eur)
          : 0;
      await safeSend(tg, chatId, formatBudgetUndo(removed, remaining, TZ));
      return;
    }

    case "quiet":
      await handleQuiet(tg, repo, user, cmd);
      return;

    case "digest":
      await handleDigest(tg, repo, user, cmd);
      return;

    default:
      // Unknown command — отвечаем только если не в silence.
      if (!isSilencedNow(user)) {
        await safeSend(tg, chatId, formatUnknown());
      }
      return;
  }
}

// ============ Callback dispatch ============

export async function dispatchCallback(
  _env: ValidatedEnv,
  repo: StateRepo,
  tg: TelegramClient,
  cbq: TelegramCallbackQuery,
  parsed: ParsedCallback,
): Promise<void> {
  if (cbq.message === undefined) {
    log("warn", "callback_missing_message", { id: cbq.id });
    if (cbq.id) await tg.answerCallbackQuery(cbq.id);
    return;
  }
  const chatId = cbq.message.chat.id;
  const messageId = cbq.message.message_id;
  // Open access: callback от незарегистрированного — auto-register как member.
  let user = await repo.getUser(chatId);
  if (user === null) {
    const owner = await repo.getOwner();
    const role = owner === null ? "owner" : "member";
    user = await repo.addUser({ chat_id: chatId, role, name: null });
    log("info", "user_registered_via_callback", { chat_id: chatId, role });
  }

  log("info", "callback", {
    chat_id: chatId,
    kind: parsed.kind,
    pct: parsed.pct,
    dur: parsed.duration,
  });

  const now = nowIso();
  const state = await repo.getBotState();
  const assetState = await repo.getPrimaryAssetState();

  if (parsed.kind === "alert_done_pct" && parsed.pct !== null) {
    const rate = assetState?.last_score_breakdown?.rate ?? 0;
    let toast: string;
    if (state.budget_target_eur !== null && state.budget_target_eur > 0) {
      const remaining = Math.max(0, state.budget_target_eur - state.budget_converted_eur);
      const eur = (remaining * parsed.pct) / 100;
      if (eur > 0 && rate > 0) {
        await repo.addConversion({ ts: now, eur, rate, pct_at_alert: parsed.pct });
        toast = formatCallbackDone(eur, rate, parsed.pct);
      } else {
        toast = formatCallbackDoneNoBudget(parsed.pct);
      }
    } else {
      toast = formatCallbackDoneNoBudget(parsed.pct);
    }
    if (cbq.id) await tg.answerCallbackQuery(cbq.id, "Записал ✅");
    await tg.editMessageReplyMarkup(chatId, messageId, null);
    await safeSend(tg, chatId, toast);
    return;
  }

  if (
    parsed.kind === "subscribe" &&
    parsed.asset_symbol !== null &&
    parsed.asset_direction !== null
  ) {
    const symbol = parsed.asset_symbol;
    const dir = parsed.asset_direction;
    const asset = await repo.getAsset(symbol);
    if (!asset) {
      if (cbq.id) await tg.answerCallbackQuery(cbq.id, "Asset не найден.");
      return;
    }
    const existing = await repo.getSubscription(chatId, symbol, dir);
    if (existing) {
      if (cbq.id) await tg.answerCallbackQuery(cbq.id, "Уже подписан.");
      return;
    }
    const count = await repo.countUserSubscriptions(chatId);
    if (count >= MAX_SUBSCRIPTIONS_PER_USER) {
      if (cbq.id) await tg.answerCallbackQuery(cbq.id, "Лимит подписок исчерпан.");
      return;
    }
    await repo.subscribeAndActivate(chatId, symbol, dir);
    log("info", "subscribed_via_callback", { chat_id: chatId, symbol, direction: dir });
    if (cbq.id) await tg.answerCallbackQuery(cbq.id, "✅ Подписан");
    await tg.editMessageReplyMarkup(chatId, messageId, null);
    await safeSend(tg, chatId, formatSubscribed(asset, dir));
    return;
  }

  if (parsed.kind === "alert_silence" && parsed.duration !== null) {
    const until = new Date(Date.now() + parsed.duration * 1000).toISOString();
    await repo.updateUserSilence(chatId, true, until, "manual");
    if (cbq.id) await tg.answerCallbackQuery(cbq.id, "Silence ✅");
    await tg.editMessageReplyMarkup(chatId, messageId, null);
    await safeSend(tg, chatId, formatCallbackSilenced(periodLabel(parsed.duration)));
    return;
  }

  if (cbq.id) await tg.answerCallbackQuery(cbq.id, "Неизвестная кнопка.");
}

// ============ Sub-handlers ============

async function handleSilence(
  tg: TelegramClient,
  repo: StateRepo,
  _user: User,
  cmd: ParsedCommand,
  chatId: number,
): Promise<void> {
  const durationSec = cmd.duration ?? 7 * 86400;
  const until = new Date(Date.now() + durationSec * 1000).toISOString();
  await repo.updateUserSilence(chatId, true, until, "manual");
  await safeSend(tg, chatId, formatSilenceSet(until, TZ));
}

// handleInvite удалён в open-access режиме — invites не нужны.
// /invite команда в dispatchMessage отвечает deprecation message.

async function handleBudget(
  tg: TelegramClient,
  repo: StateRepo,
  user: User,
  cmd: ParsedCommand,
): Promise<void> {
  if (cmd.budget_target_eur === null) {
    const state = await repo.getBotState();
    const conversions = await repo.listConversions();
    await safeSend(
      tg,
      user.chat_id,
      formatBudgetShow(
        state,
        conversions.map((c) => ({ ts: c.ts, eur: c.eur, rate: c.rate })),
        nowIso(),
        TZ,
      ),
    );
    return;
  }
  const now = new Date();
  const days = cmd.budget_days ?? 30;
  const deadline = new Date(now.getTime() + days * 86400_000).toISOString();
  await repo.setBudget(cmd.budget_target_eur, deadline, now.toISOString());
  const state = await repo.getBotState();
  await safeSend(tg, user.chat_id, formatBudgetSet(state, TZ));
}

async function handleBudgetDone(
  tg: TelegramClient,
  repo: StateRepo,
  user: User,
  cmd: ParsedCommand,
): Promise<void> {
  const state = await repo.getBotState();
  if (state.budget_target_eur === null) {
    await safeSend(tg, user.chat_id, formatBudgetNoActive());
    return;
  }
  const eur = cmd.budget_done_eur ?? 0;
  let rate = cmd.budget_done_rate;
  if (rate === null) {
    const assetState = await repo.getPrimaryAssetState();
    rate = assetState?.last_score_breakdown?.rate ?? 0;
  }
  await repo.addConversion({ ts: nowIso(), eur, rate, pct_at_alert: null });
  const updatedState = await repo.getBotState();
  await safeSend(tg, user.chat_id, formatBudgetDone(updatedState, eur, rate));
}

async function handleQuiet(
  tg: TelegramClient,
  repo: StateRepo,
  user: User,
  cmd: ParsedCommand,
): Promise<void> {
  if (cmd.quiet_off) {
    await repo.updateUserQuiet(user.chat_id, false, user.quiet_from_hour, user.quiet_to_hour);
    await safeSend(tg, user.chat_id, formatQuietOff());
    return;
  }
  if (cmd.quiet_from === null || cmd.quiet_to === null) {
    // show
    const fresh = await repo.getUser(user.chat_id);
    await safeSend(tg, user.chat_id, formatQuietShow(fresh, TZ));
    return;
  }
  await repo.updateUserQuiet(user.chat_id, true, cmd.quiet_from, cmd.quiet_to);
  await safeSend(tg, user.chat_id, formatQuietSet(cmd.quiet_from, cmd.quiet_to, TZ));
}

async function handleDigest(
  tg: TelegramClient,
  repo: StateRepo,
  user: User,
  cmd: ParsedCommand,
): Promise<void> {
  if (cmd.digest_on === null) {
    const fresh = await repo.getUser(user.chat_id);
    await safeSend(tg, user.chat_id, formatDigestShow(fresh));
    return;
  }
  await repo.setDigestEnabled(user.chat_id, cmd.digest_on);
  await safeSend(
    tg,
    user.chat_id,
    formatDigestSet(cmd.digest_on, DEFAULT_DIGEST_HOUR, DEFAULT_DIGEST_MINUTE, TZ),
  );
}

// ============ /status, /explain (multi-asset aware) ============

/**
 * /status [SYMBOL]:
 *   - без аргумента + есть подписки: overview всех подписок
 *   - без аргумента + 0 подписок: legacy EUR/USD (через getPrimaryAssetState)
 *   - с symbol: per-asset breakdown через formatStatus(assetState, user, tz, asset)
 *
 * Без аргумента + 0 подписок сохраняем legacy fallback на EUR/USD — свежий юзер
 * до /subscribe может увидеть baseline.
 */
async function handleStatus(
  repo: StateRepo,
  tg: TelegramClient,
  user: User,
  cmd: ParsedCommand,
): Promise<void> {
  if (cmd.asset_symbol !== null) {
    const symbol = cmd.asset_symbol;
    const asset = await repo.getAsset(symbol);
    if (asset === null) {
      await safeSend(tg, user.chat_id, formatStatusNotSubscribed(symbol));
      return;
    }
    if (!asset.active) {
      await safeSend(tg, user.chat_id, formatStatusAssetInactive(asset));
      return;
    }
    const state = await repo.getAssetState(symbol);
    if (state === null || state.last_score_breakdown === null) {
      await safeSend(tg, user.chat_id, formatStatusNoData(asset));
      return;
    }
    await safeSend(tg, user.chat_id, formatStatus(state, user, TZ, asset));
    return;
  }
  const subs = await repo.listUserSubscriptions(user.chat_id);
  if (subs.length === 0) {
    await safeSend(tg, user.chat_id, formatStatus(await repo.getPrimaryAssetState(), user, TZ));
    return;
  }
  const assets: Record<string, Asset> = {};
  const states: Record<string, AssetState | null> = {};
  for (const s of subs) {
    const a = await repo.getAsset(s.symbol);
    if (a) assets[s.symbol] = a;
    states[s.symbol] = await repo.getAssetState(s.symbol);
  }
  await safeSend(tg, user.chat_id, formatStatusOverview(subs, assets, states, user, TZ));
}

/**
 * /explain [SYMBOL]:
 *   - без аргумента + нет non-EUR/USD подписок: legacy EUR/USD primary
 *   - без аргумента + есть non-EUR/USD подписки: legacy EUR/USD + hint про /explain SYMBOL
 *   - с symbol: per-asset breakdown
 */
async function handleExplain(
  repo: StateRepo,
  tg: TelegramClient,
  user: User,
  cmd: ParsedCommand,
): Promise<void> {
  if (cmd.asset_symbol !== null) {
    const symbol = cmd.asset_symbol;
    const asset = await repo.getAsset(symbol);
    if (asset === null) {
      await safeSend(tg, user.chat_id, formatStatusNotSubscribed(symbol));
      return;
    }
    if (!asset.active) {
      await safeSend(tg, user.chat_id, formatStatusAssetInactive(asset));
      return;
    }
    const state = await repo.getAssetState(symbol);
    if (state === null || state.last_score_breakdown === null) {
      await safeSend(tg, user.chat_id, formatStatusNoData(asset));
      return;
    }
    await safeSend(tg, user.chat_id, formatExplain(state, TZ, asset));
    return;
  }
  // /explain без аргумента — primary EUR/USD legacy view + hint про SYMBOL.
  // Hint показываем всегда (даже без non-EUR/USD подписок) — discovery
  // механизм для всех multi-asset features.
  const state = await repo.getPrimaryAssetState();
  const baseExplain = formatExplain(state, TZ);
  const text = `${baseExplain}\n\n<i>Подробнее по конкретному ассету: <code>/explain SYMBOL</code></i>`;
  await safeSend(tg, user.chat_id, text);
}

// ============ Misc ============

// ============ Subscribe / Unsubscribe / Assets ============

async function handleSubscribe(
  env: ValidatedEnv,
  repo: StateRepo,
  tg: TelegramClient,
  user: User,
  cmd: ParsedCommand,
): Promise<void> {
  // Empty /subscribe → show help.
  if (cmd.asset_symbol === null) {
    const subs = await repo.listUserSubscriptions(user.chat_id);
    const assets: Record<string, Asset> = {};
    const states: Record<string, AssetState | null> = {};
    for (const s of subs) {
      const a = await repo.getAsset(s.symbol);
      if (a) assets[s.symbol] = a;
      states[s.symbol] = await repo.getAssetState(s.symbol);
    }
    await safeSend(tg, user.chat_id, formatUserAssets(subs, assets, states));
    return;
  }

  // Limit check.
  const currentCount = await repo.countUserSubscriptions(user.chat_id);
  if (currentCount >= MAX_SUBSCRIPTIONS_PER_USER) {
    await safeSend(
      tg,
      user.chat_id,
      formatSubscribeLimit(currentCount, MAX_SUBSCRIPTIONS_PER_USER),
    );
    return;
  }

  const rawSymbol = cmd.asset_symbol;

  // Check если asset уже в registry (например EUR/USD).
  let asset = await repo.getAsset(rawSymbol);
  if (asset === null) {
    // Global limit check — TwelveData free quota (800 calls/day → ~15 unique
    // assets). Защита от лопанья free tier при scale.
    const activeAssets = await repo.listActiveAssets();
    if (activeAssets.length >= MAX_ACTIVE_ASSETS_GLOBAL) {
      await safeSend(
        tg,
        user.chat_id,
        `Сейчас ${activeAssets.length} активов в работе — это лимит free tier (${MAX_ACTIVE_ASSETS_GLOBAL}). Подпишись на уже существующие через /assets или подожди когда какой-то из них освободится. Расширим лимит когда upgrade'нем TwelveData ($30/мес).`,
      );
      return;
    }
    // Resolve через providers — Auto fallback (twelvedata + moex).
    const result = await resolveSymbolAuto(rawSymbol, env.TWELVEDATA_API_KEY);
    if (result === null) {
      await safeSend(tg, user.chat_id, formatSubscribeNotFound(rawSymbol));
      return;
    }
    asset = await repo.upsertAsset({
      symbol: result.resolved.symbol,
      display_name: result.resolved.display_name,
      type: result.resolved.type,
      provider: result.provider,
      currency: result.resolved.currency,
    });
  }

  // Если direction указан в команде — сразу subscribe.
  if (cmd.asset_direction !== null) {
    const existing = await repo.getSubscription(user.chat_id, asset.symbol, cmd.asset_direction);
    if (existing !== null) {
      await safeSend(tg, user.chat_id, formatAlreadySubscribed(asset, cmd.asset_direction));
      return;
    }
    await repo.subscribeAndActivate(user.chat_id, asset.symbol, cmd.asset_direction);
    log("info", "subscribed", {
      chat_id: user.chat_id,
      symbol: asset.symbol,
      direction: cmd.asset_direction,
    });
    await safeSend(tg, user.chat_id, formatSubscribed(asset, cmd.asset_direction));
    return;
  }

  // Без direction — показать prompt с inline buttons.
  const state = await repo.getAssetState(asset.symbol);
  const currentPrice = state?.last_score_breakdown?.rate ?? null;
  try {
    await tg.sendMessage(user.chat_id, formatSubscribePrompt(asset, currentPrice), {
      reply_markup: subscribePromptKeyboard(asset.symbol),
    });
  } catch (err) {
    if (err instanceof TelegramAuthError) throw err;
    log("error", "subscribe_prompt_failed", {
      chat_id: user.chat_id,
      error: String(err).slice(0, 200),
    });
  }
}

async function handleUnsubscribe(
  _env: ValidatedEnv,
  repo: StateRepo,
  tg: TelegramClient,
  user: User,
  cmd: ParsedCommand,
): Promise<void> {
  if (cmd.asset_symbol === null) {
    // Без аргумента — показать список как /assets.
    const subs = await repo.listUserSubscriptions(user.chat_id);
    const assets: Record<string, Asset> = {};
    const states: Record<string, AssetState | null> = {};
    for (const s of subs) {
      const a = await repo.getAsset(s.symbol);
      if (a) assets[s.symbol] = a;
      states[s.symbol] = await repo.getAssetState(s.symbol);
    }
    await safeSend(tg, user.chat_id, formatUserAssets(subs, assets, states));
    return;
  }

  const symbol = cmd.asset_symbol;
  const asset = await repo.getAsset(symbol);

  let removed: number;
  if (cmd.asset_direction !== null) {
    removed = (await repo.removeSubscription(user.chat_id, symbol, cmd.asset_direction)) ? 1 : 0;
  } else {
    removed = await repo.removeAllSubscriptionsForSymbol(user.chat_id, symbol);
  }

  log("info", "unsubscribed", { chat_id: user.chat_id, symbol, removed });
  if (asset) {
    await repo.deactivateAssetIfOrphan(symbol);
    await safeSend(tg, user.chat_id, formatUnsubscribed(asset, removed));
  } else {
    await safeSend(tg, user.chat_id, `Не подписан на ${symbol}.`);
  }
}

async function handleAssets(repo: StateRepo, tg: TelegramClient, user: User): Promise<void> {
  const subs = await repo.listUserSubscriptions(user.chat_id);
  const assets: Record<string, Asset> = {};
  const states: Record<string, AssetState | null> = {};
  for (const s of subs) {
    const a = await repo.getAsset(s.symbol);
    if (a) assets[s.symbol] = a;
    states[s.symbol] = await repo.getAssetState(s.symbol);
  }
  await safeSend(tg, user.chat_id, formatUserAssets(subs, assets, states));
}

function isSilencedNow(user: User): boolean {
  if (!user.silence_active || user.silence_until === null) return false;
  return new Date(user.silence_until).getTime() > Date.now();
}

function formatSenderName(message: TelegramMessage): string | null {
  if (message.from === undefined) return null;
  const first = message.from.first_name ?? "";
  const last = message.from.last_name ?? "";
  const full = `${first} ${last}`.trim();
  if (full) return full;
  if (message.from.username) return `@${message.from.username}`;
  return null;
}

// Helper used by alert broadcast (analyze job)
export { computeEdgePct };

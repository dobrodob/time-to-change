import { dispatchCallback, dispatchMessage } from "../commands/handlers";
import type { ValidatedEnv } from "../env";
/**
 * Webhook handler — POST /telegram. Telegram отправляет сюда апдейты после setWebhook.
 *
 * Защита:
 * - X-Telegram-Bot-Api-Secret-Token header == env.TELEGRAM_WEBHOOK_SECRET
 *   (constant-time compare, 32-char min)
 * - Body — JSON Update; иначе 400.
 *
 * Performance: возвращаем 200 OK Telegram'у **немедленно** через ctx.waitUntil,
 * чтобы handler работал асинхронно и Telegram не retry'ил.
 */
import { log } from "../lib/log";
import { StateRepo } from "../state/repo";
import { TelegramClient } from "./api";
import { parseCallbackV2, parseCommand } from "./parser";
import type { TelegramUpdate } from "./types";

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export async function handleWebhook(
  request: Request,
  env: ValidatedEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (secret === null || !constantTimeEqual(secret, env.TELEGRAM_WEBHOOK_SECRET)) {
    log("warn", "webhook_auth_failed", { has_header: secret !== null });
    return new Response("unauthorized", { status: 401 });
  }

  let update: TelegramUpdate;
  try {
    update = (await request.json()) as TelegramUpdate;
  } catch {
    return new Response("bad json", { status: 400 });
  }
  if (typeof update.update_id !== "number") {
    return new Response("bad payload", { status: 400 });
  }

  // Process update in background — Telegram должен видеть 200 OK immediately,
  // иначе retry в течение 60 секунд.
  ctx.waitUntil(processUpdate(update, env));
  return new Response("ok", { status: 200 });
}

async function processUpdate(update: TelegramUpdate, env: ValidatedEnv): Promise<void> {
  const repo = new StateRepo(env.DB);
  const tg = new TelegramClient(env.TELEGRAM_BOT_TOKEN);
  try {
    if (update.message !== undefined && update.message.text !== undefined) {
      const cmd = parseCommand(update.message.text);
      log("info", "command", {
        update_id: update.update_id,
        chat_id: update.message.chat.id,
        kind: cmd.kind,
        sender: update.message.from?.first_name ?? null,
      });
      await dispatchMessage(env, repo, tg, update.message, cmd);
    } else if (update.callback_query !== undefined) {
      const parsed = parseCallbackV2(update.callback_query.data ?? "");
      await dispatchCallback(env, repo, tg, update.callback_query, parsed);
    } else {
      log("info", "webhook_unhandled_update", { update_id: update.update_id });
    }
    await repo.updateLastUpdateId(update.update_id);
  } catch (err) {
    log("error", "webhook_process_failed", {
      update_id: update.update_id,
      error: String(err).slice(0, 500),
    });
  }
}

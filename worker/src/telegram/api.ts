/**
 * Telegram Bot API client. Минимальный: sendMessage, edit reply markup,
 * answerCallbackQuery, setMyCommands. Port of src/telegram_io/client.py.
 *
 * Errors:
 * - TelegramAuthError на 401 (токен инвалид)
 * - TelegramBlockedError на 403 (бот заблокирован user'ом)
 * - Generic Error на остальные
 */
import { log } from "../lib/log";

export class TelegramAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelegramAuthError";
  }
}

export class TelegramBlockedError extends Error {
  constructor() {
    super("Bot was blocked by the recipient");
    this.name = "TelegramBlockedError";
  }
}

export class TelegramNetworkError extends Error {
  constructor() {
    super("Telegram request failed");
    this.name = "TelegramNetworkError";
  }
}

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

export type InlineKeyboard = InlineKeyboardButton[][];

export interface BotCommand {
  command: string;
  description: string;
}

export interface SendMessageOptions {
  parse_mode?: "HTML" | "Markdown";
  reply_markup?: InlineKeyboard;
  disable_notification?: boolean;
  disable_web_page_preview?: boolean;
}

export class TelegramClient {
  private static readonly TIMEOUT_MS = 8000;

  constructor(private readonly token: string) {}

  private url(method: string): string {
    return `https://api.telegram.org/bot${this.token}/${method}`;
  }

  private async post(method: string, body: Record<string, unknown>): Promise<Response> {
    try {
      return await fetch(this.url(method), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TelegramClient.TIMEOUT_MS),
      });
    } catch {
      // A fetch error can contain the credential-bearing request URL. Replace it
      // at the client boundary before upstream code can log the exception.
      throw new TelegramNetworkError();
    }
  }

  async sendMessage(
    chatId: number,
    text: string,
    opts: SendMessageOptions = {},
  ): Promise<number | null> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text,
      parse_mode: opts.parse_mode ?? "HTML",
      disable_web_page_preview: opts.disable_web_page_preview ?? true,
    };
    if (opts.reply_markup) body.reply_markup = { inline_keyboard: opts.reply_markup };
    if (opts.disable_notification) body.disable_notification = true;

    const res = await this.post("sendMessage", body);
    if (!res.ok) {
      log("error", "telegram_send_failed", {
        status: res.status,
      });
      if (res.status === 401) throw new TelegramAuthError("Telegram authentication failed");
      if (res.status === 403) throw new TelegramBlockedError();
      throw new Error(`Telegram sendMessage failed with status ${res.status}`);
    }
    const data = (await res.json()) as { ok: boolean; result?: { message_id: number } };
    return data.result?.message_id ?? null;
  }

  async editMessageReplyMarkup(
    chatId: number,
    messageId: number,
    inlineKeyboard: InlineKeyboard | null,
  ): Promise<void> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: inlineKeyboard ?? [] },
    };
    const res = await this.post("editMessageReplyMarkup", body);
    if (!res.ok) {
      // 400 "message is not modified" — нормально при повторном клике.
      log("warn", "telegram_edit_markup_failed", { status: res.status });
    }
  }

  async answerCallbackQuery(callbackId: string, text?: string): Promise<void> {
    const body: Record<string, unknown> = { callback_query_id: callbackId };
    if (text) {
      body.text = text.slice(0, 200);
      body.show_alert = false;
    }
    const res = await this.post("answerCallbackQuery", body);
    if (!res.ok) {
      log("warn", "telegram_callback_answer_failed", {
        status: res.status,
      });
    }
  }

  async setMyCommands(commands: BotCommand[]): Promise<void> {
    const res = await this.post("setMyCommands", { commands });
    if (!res.ok) {
      log("warn", "telegram_setmycommands_failed", {
        status: res.status,
      });
      if (res.status === 401) throw new TelegramAuthError("Telegram authentication failed");
      throw new Error(`Telegram setMyCommands failed with status ${res.status}`);
    }
  }
}

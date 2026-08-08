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
  constructor(public chatId: number) {
    super(`Bot blocked by ${chatId}`);
    this.name = "TelegramBlockedError";
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
  constructor(private readonly token: string) {}

  private url(method: string): string {
    return `https://api.telegram.org/bot${this.token}/${method}`;
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

    const res = await fetch(this.url("sendMessage"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errText = await res.text();
      log("error", "telegram_send_failed", {
        chat_id: chatId,
        status: res.status,
        body: errText.slice(0, 200),
      });
      if (res.status === 401) throw new TelegramAuthError(errText);
      if (res.status === 403) throw new TelegramBlockedError(chatId);
      throw new Error(`Telegram sendMessage failed: ${res.status} ${errText.slice(0, 200)}`);
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
    const res = await fetch(this.url("editMessageReplyMarkup"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      // 400 "message is not modified" — нормально при повторном клике.
      log("warn", "telegram_edit_markup_failed", { chat_id: chatId, status: res.status });
    }
  }

  async answerCallbackQuery(callbackId: string, text?: string): Promise<void> {
    const body: Record<string, unknown> = { callback_query_id: callbackId };
    if (text) {
      body.text = text.slice(0, 200);
      body.show_alert = false;
    }
    const res = await fetch(this.url("answerCallbackQuery"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      log("warn", "telegram_callback_answer_failed", {
        callback_id: callbackId,
        status: res.status,
      });
    }
  }

  async setMyCommands(commands: BotCommand[]): Promise<void> {
    const res = await fetch(this.url("setMyCommands"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commands }),
    });
    if (!res.ok) {
      const errText = await res.text();
      log("warn", "telegram_setmycommands_failed", {
        status: res.status,
        body: errText.slice(0, 200),
      });
    }
  }
}

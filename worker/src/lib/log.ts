/**
 * Structured logger. Single JSON line per event → CF Observability filterable.
 *
 * Используется во всём Worker'е вместо `console.log`. В CF dashboard'е
 * можно отфильтровать по `op` (analyze_done, command, telegram_send_failed,
 * webhook_auth_failed, etc), `level`, любым полям из `ctx`.
 */
type Level = "info" | "warn" | "error" | "debug";

interface LogEntry {
  ts: string;
  level: Level;
  op: string;
  [key: string]: unknown;
}

const BLOCKED_CONTEXT_KEYS = new Set([
  "body",
  "callback_id",
  "chat_id",
  "chatid",
  "error",
  "first_name",
  "last_name",
  "name",
  "sender",
  "username",
]);

function isBlockedKey(key: string): boolean {
  const normalized = key.toLowerCase();
  if (BLOCKED_CONTEXT_KEYS.has(normalized)) return true;
  return (
    normalized.includes("password") ||
    normalized.includes("secret") ||
    normalized.includes("token") ||
    normalized === "url" ||
    normalized.endsWith("_url") ||
    normalized.includes("api_key")
  );
}

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value !== null && typeof value === "object") {
    const safe: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (!isBlockedKey(key)) safe[key] = sanitizeValue(nested);
    }
    return safe;
  }
  return value;
}

function sanitizeContext(ctx: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(ctx)) {
    if (key === "ts" || key === "level" || key === "op" || isBlockedKey(key)) continue;
    safe[key] = sanitizeValue(value);
  }
  return safe;
}

/** Stable diagnostic classification without exception messages or URLs. */
export function errorKind(err: unknown): string {
  if (err instanceof Error && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(err.name)) {
    return err.name;
  }
  return typeof err;
}

export function log(level: Level, op: string, ctx: Record<string, unknown> = {}): void {
  const entry: LogEntry = {
    ...sanitizeContext(ctx),
    ts: new Date().toISOString(),
    level,
    op,
  };
  console.log(JSON.stringify(entry));
}

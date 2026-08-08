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

export function log(level: Level, op: string, ctx: Record<string, unknown> = {}): void {
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    op,
    ...ctx,
  };
  console.log(JSON.stringify(entry));
}

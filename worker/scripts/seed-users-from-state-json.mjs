#!/usr/bin/env node
/**
 * Генерирует SQL для переноса пользователей из legacy state.json в D1.
 * Вывод содержит персональные данные: запускайте скрипт только локально,
 * сохраняйте результат во временный игнорируемый файл и никогда не коммитьте
 * его и не печатайте в CI logs.
 *
 * Usage:
 *   node scripts/seed-users-from-state-json.mjs path/to/state.json > /tmp/seed-users.sql
 */
import { readFileSync } from "node:fs";
import { argv, stderr, stdout, exit } from "node:process";

function escape(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  return `'${String(value).replace(/'/g, "''")}'`;
}

function main() {
  const inputPath = argv[2];
  if (!inputPath) {
    stderr.write("Usage: node scripts/seed-users-from-state-json.mjs path/to/state.json\n");
    exit(1);
  }
  const raw = readFileSync(inputPath, "utf-8");
  const data = JSON.parse(raw);
  const users = data?.telegram?.users ?? [];
  const lastUpdateId = data?.telegram?.last_update_id ?? 0;

  stdout.write(`-- Generated locally from a legacy state file at ${new Date().toISOString()}\n`);
  stdout.write(`-- ${users.length} user(s) + last_update_id=${lastUpdateId}\n\n`);

  for (const u of users) {
    const fields = [
      escape(u.chat_id),
      escape(u.role),
      escape(u.name ?? null),
      escape(u.joined_at),
      escape(u.silence?.active ?? false),
      escape(u.silence?.until ?? null),
      escape(u.silence?.reason ?? null),
      escape(u.quiet?.enabled ?? false),
      escape(u.quiet?.from_hour ?? 23),
      escape(u.quiet?.to_hour ?? 7),
      escape(u.digest_enabled ?? true),
    ];
    stdout.write(
      `INSERT INTO users (chat_id, role, name, joined_at, silence_active, silence_until, silence_reason, quiet_enabled, quiet_from_hour, quiet_to_hour, digest_enabled) VALUES (${fields.join(", ")})\n` +
        "  ON CONFLICT(chat_id) DO NOTHING;\n",
    );
  }
  stdout.write(`\nUPDATE bot_state SET last_update_id = ${escape(lastUpdateId)} WHERE id = 1;\n`);
}

main();

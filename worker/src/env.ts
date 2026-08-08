/**
 * Env validation через zod. Вызывается **в начале** каждого fetch/scheduled
 * handler — fail-loud если biding/secret отсутствует.
 *
 * Возвращает `ValidatedEnv` со всеми гарантиями типов; дальше передаётся
 * в handlers explicitly (no global state).
 */
import { z } from "zod";

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN must not be empty"),
  TELEGRAM_WEBHOOK_SECRET: z
    .string()
    .min(32, "TELEGRAM_WEBHOOK_SECRET must be >=32 chars (use `openssl rand -hex 32`)"),
  TWELVEDATA_API_KEY: z.string().min(1, "TWELVEDATA_API_KEY must not be empty"),
});

export type ValidatedEnv = z.infer<typeof envSchema> & { DB: D1Database };

export function validateEnv(env: unknown): ValidatedEnv {
  if (!env || typeof env !== "object") {
    throw new Error("env is missing or not an object");
  }
  const e = env as { DB?: D1Database } & Record<string, unknown>;
  if (!e.DB) {
    throw new Error("D1 binding 'DB' missing in env — check wrangler.toml");
  }
  const parsed = envSchema.parse(e);
  return { ...parsed, DB: e.DB };
}

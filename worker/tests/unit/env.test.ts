import { describe, expect, it } from "vitest";
import { validateEnv } from "../../src/env";

const VALID_SECRET = "x".repeat(32);

describe("validateEnv", () => {
  it("throws when env is null or not object", () => {
    expect(() => validateEnv(null)).toThrow();
    expect(() => validateEnv(undefined)).toThrow();
    expect(() => validateEnv("string")).toThrow();
  });

  it("throws on missing DB binding", () => {
    expect(() =>
      validateEnv({
        TELEGRAM_BOT_TOKEN: "t",
        TELEGRAM_WEBHOOK_SECRET: VALID_SECRET,
        TWELVEDATA_API_KEY: "k",
      }),
    ).toThrow(/D1 binding 'DB' missing/);
  });

  it("throws on missing TELEGRAM_BOT_TOKEN", () => {
    expect(() => validateEnv({ DB: {} as D1Database })).toThrow();
  });

  it("throws on TELEGRAM_WEBHOOK_SECRET shorter than 32 chars", () => {
    expect(() =>
      validateEnv({
        DB: {} as D1Database,
        TELEGRAM_BOT_TOKEN: "tok",
        TELEGRAM_WEBHOOK_SECRET: "short",
        TWELVEDATA_API_KEY: "k",
      }),
    ).toThrow(/>=32 chars/);
  });

  it("throws on empty TWELVEDATA_API_KEY", () => {
    expect(() =>
      validateEnv({
        DB: {} as D1Database,
        TELEGRAM_BOT_TOKEN: "tok",
        TELEGRAM_WEBHOOK_SECRET: VALID_SECRET,
        TWELVEDATA_API_KEY: "",
      }),
    ).toThrow();
  });

  it("accepts valid env, returns typed object", () => {
    const e = validateEnv({
      DB: { id: "test" } as unknown as D1Database,
      TELEGRAM_BOT_TOKEN: "tok-123",
      TELEGRAM_WEBHOOK_SECRET: VALID_SECRET,
      TWELVEDATA_API_KEY: "key-abc",
    });
    expect(e.TELEGRAM_BOT_TOKEN).toBe("tok-123");
    expect(e.TWELVEDATA_API_KEY).toBe("key-abc");
    expect(e.DB).toBeDefined();
  });
});

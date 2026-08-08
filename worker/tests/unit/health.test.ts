import { describe, expect, it, vi } from "vitest";
import type { ValidatedEnv } from "../../src/env";
import { handleHealth } from "../../src/lib/health";

describe("health privacy", () => {
  it("returns a generic failure without exposing database error text", async () => {
    const env = {
      TELEGRAM_BOT_TOKEN: "test",
      TELEGRAM_WEBHOOK_SECRET: "x".repeat(32),
      TWELVEDATA_API_KEY: "test",
      DB: { prepare: vi.fn(() => { throw new Error("sensitive database details"); }) },
    } as unknown as ValidatedEnv;
    const response = await handleHealth(env);
    const body = await response.json<{ ok: boolean; error: string }>();
    expect(response.status).toBe(500);
    expect(body).toEqual({ ok: false, error: "health check failed" });
    expect(JSON.stringify(body)).not.toContain("sensitive database details");
  });
});

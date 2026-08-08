import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpError, fetchWithRetry } from "../../src/lib/http";

describe("fetchWithRetry", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("возвращает Response на 200, прокидывает url + headers", async () => {
    const seen: { url: string; headers: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init: RequestInit) => {
        seen.push({ url: String(url), headers: init?.headers });
        return new Response("ok", { status: 200 });
      }),
    );
    const res = await fetchWithRetry("https://x.test/data", { headers: { "X-Test": "1" } });
    expect(res.status).toBe(200);
    expect(seen[0].url).toBe("https://x.test/data");
    expect(seen[0].headers).toMatchObject({ "X-Test": "1" });
  });

  it("4xx (не 429) — фатально, без retry, HttpError со status", async () => {
    const m = vi.fn(async () => new Response("nope", { status: 404 }));
    vi.stubGlobal("fetch", m);
    await expect(fetchWithRetry("https://x.test")).rejects.toThrow(/404/);
    expect(m).toHaveBeenCalledTimes(1);
    await expect(fetchWithRetry("https://x.test")).rejects.toBeInstanceOf(HttpError);
  });

  it("429 — ретраит до maxRetries затем кидает", async () => {
    vi.useFakeTimers();
    const m = vi.fn(async () => new Response("rl", { status: 429 }));
    vi.stubGlobal("fetch", m);
    const settled = fetchWithRetry("https://x.test", { maxRetries: 3 }).then(
      () => "ok",
      (e) => `err:${String(e)}`,
    );
    await vi.runAllTimersAsync();
    expect(await settled).toMatch(/429/);
    expect(m).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it("transient 503 затем 200 — ретраит и возвращает", async () => {
    vi.useFakeTimers();
    let n = 0;
    const m = vi.fn(async () =>
      n++ === 0 ? new Response("e", { status: 503 }) : new Response("ok", { status: 200 }),
    );
    vi.stubGlobal("fetch", m);
    const settled = fetchWithRetry("https://x.test").then(
      (r) => r.status,
      (e) => e,
    );
    await vi.runAllTimersAsync();
    expect(await settled).toBe(200);
    expect(m).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});

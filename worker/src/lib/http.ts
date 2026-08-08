/**
 * fetch с таймаутом и retry — общий для flaky бесплатных endpoint'ов (Yahoo,
 * Coinbase). 429 и 5xx ретраим с экспоненциальным backoff; прочие 4xx (404 —
 * битый тикер/символ) фатальны без retry. Network/timeout(abort) — ретраябельны.
 * Кидает HttpError. creditsUsed у таких провайдеров = 0, так что retry бесплатны.
 */

export class HttpError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export interface FetchRetryOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxRetries?: number;
  baseDelayMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function fetchWithRetry(url: string, opts: FetchRetryOptions = {}): Promise<Response> {
  const {
    headers = { "User-Agent": "Mozilla/5.0" },
    timeoutMs = 8000,
    maxRetries = 3,
    baseDelayMs = 1000,
  } = opts;
  let delayMs = baseDelayMs;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      lastErr = err; // network / timeout(abort) — ретраябельно
      if (attempt < maxRetries) {
        await sleep(delayMs);
        delayMs *= 2;
        continue;
      }
      throw new HttpError(`fetch failed: ${String(err).slice(0, 200)}`);
    }
    if (res.ok) return res;
    if (res.status !== 429 && res.status < 500) {
      // фатальный 4xx — не ретраим
      throw new HttpError(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`, res.status);
    }
    lastErr = new HttpError(`HTTP ${res.status}`, res.status);
    if (attempt < maxRetries) {
      await sleep(delayMs);
      delayMs *= 2;
    }
  }
  throw lastErr instanceof Error ? lastErr : new HttpError("fetch failed");
}

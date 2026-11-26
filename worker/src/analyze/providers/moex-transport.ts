import { Client } from "tunnelfetch";
import { MOEX_ROOT_CA } from "./moex-root-ca";

export const MOEX_ISS_ORIGIN = "https://iss.moex.com";

export interface MoexTransport {
  fetch(url: string, init: RequestInit): Promise<Response>;
}

export function createMoexTransport(): MoexTransport {
  return {
    async fetch(url, init) {
      if (new URL(url).origin !== MOEX_ISS_ORIGIN) throw new Error("Unexpected MOEX origin");
      const { connect } = await import("cloudflare:sockets");
      // A reused ISS connection can stall partway through the next body on Workers.
      const client = new Client({
        connect: (address, options) =>
          connect(address, {
            secureTransport: options?.secureTransport ?? "off",
            allowHalfOpen: options?.allowHalfOpen ?? false,
          }),
        trust: { mode: "anchors", anchors: [MOEX_ROOT_CA] },
        maxBodyBytes: 1_048_576,
        timeouts: { idleMs: 5000, totalMs: 8000 },
      });
      try {
        const response = await client.fetch(url, { ...init, redirect: "manual" });
        if (!response.ok) {
          await response.body?.cancel();
          return response;
        }
        // Read the complete body before returning so fetchWithRetry can retry read failures.
        return new Response(await response.arrayBuffer(), response);
      } finally {
        await client.close();
      }
    },
  };
}

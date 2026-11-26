import { Client } from "tunnelfetch";
import { MOEX_ROOT_CA } from "./moex-root-ca";

export const MOEX_ISS_ORIGIN = "https://iss.moex.com";

export interface MoexTransport {
  fetch(url: string, init: RequestInit): Promise<Response>;
  close?(): Promise<void>;
}

export function createMoexTransport(): MoexTransport {
  let client: Client | undefined;
  return {
    async fetch(url, init) {
      if (new URL(url).origin !== MOEX_ISS_ORIGIN) throw new Error("Unexpected MOEX origin");
      if (!client) {
        const { connect } = await import("cloudflare:sockets");
        client = new Client({
          connect: (address, options) =>
            connect(address, {
              secureTransport: options?.secureTransport ?? "off",
              allowHalfOpen: options?.allowHalfOpen ?? false,
            }),
          trust: { mode: "anchors", anchors: [MOEX_ROOT_CA] },
          maxBodyBytes: 1_048_576,
        });
      }
      const response = await client.fetch(url, { ...init, redirect: "manual" });
      if (!response.ok) await response.body?.cancel();
      return response;
    },
    async close() {
      await client?.close();
      client = undefined;
    },
  };
}

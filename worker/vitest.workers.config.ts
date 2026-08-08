/**
 * Integration-config: использует @cloudflare/vitest-pool-workers + Miniflare
 * (in-memory D1, KV, etc). Workerd binary НЕ доступен для Windows native —
 * запускается в CI Linux, локально через WSL или skip.
 *
 * Используется для tests/integration/.
 */
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        d1Databases: ["DB"],
      },
    }),
  ],
  test: {
    include: ["tests/integration/**/*.test.ts"],
  },
});

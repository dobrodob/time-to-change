/**
 * Unit-config: pure-функции, mocked dependencies, без CF runtime.
 * Используется для tests/unit/ и tests/parity/.
 * Запускается ВЕЗДЕ (Windows local + CI Linux).
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/parity/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/types.ts", "src/index.ts"],
    },
  },
});

import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    root: path.resolve(__dirname),
    include: ["plan/__tests__/*.test.ts", "apply/__tests__/*.test.ts"],
    environment: "node",
    // Mirror the other 3 vitest configs in the monorepo: hard timeouts and
    // strict mock hygiene to prevent inter-test state leaks.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    clearMocks: true,
    restoreMocks: true,
    mockReset: true,
  },
});

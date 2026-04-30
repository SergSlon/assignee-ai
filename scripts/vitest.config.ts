/**
 * vitest.config.ts for scripts/ tests.
 *
 * Resolves @assignee/core and its sub-paths to the workspace package dist
 * so scripts that import from @assignee/core/audit can be tested outside of
 * any individual workspace package context.
 */

import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(__dirname, "..");

export default defineConfig({
  resolve: {
    alias: [
      // @assignee/core/audit → packages/core/dist/audit/index.js
      {
        find: /^@assignee\/core\/(.+)$/,
        replacement: path.join(workspaceRoot, "packages/core/dist/$1/index.js"),
      },
      // @assignee/core → packages/core/dist/index.js
      {
        find: "@assignee/core",
        replacement: path.join(workspaceRoot, "packages/core/dist/index.js"),
      },
    ],
  },
  test: {
    root: __dirname,
    include: ["**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    environment: "node",
    clearMocks: true,
    restoreMocks: true,
    mockReset: true,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    root: path.resolve(__dirname),
    include: ["plan/__tests__/*.test.ts", "apply/__tests__/*.test.ts"],
    environment: "node",
  },
});

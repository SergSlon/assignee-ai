import { config } from "@assignee/eslint-config/base";

/** @type {import("eslint").Linter.Config[]} */
export default [
  ...config,
  {
    linterOptions: {
      reportUnusedDisableDirectives: false,
    },
    rules: {
      // N6 audit finding (2026-04-06): downgraded from "off" to "warn" so
      // lint catches NEW violations. This package currently has zero debt
      // for these rules so the ceiling stays at 0.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": "warn",
      "no-useless-escape": "off",
      "no-control-regex": "off",
      "turbo/no-undeclared-env-vars": "off",
    },
  },
  {
    ignores: ["dist/**", "coverage/**", "scripts/**", "__tests__/**"],
  },
];

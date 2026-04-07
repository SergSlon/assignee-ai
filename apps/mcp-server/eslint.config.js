import { config } from "@assignee/eslint-config/base";

/** @type {import("eslint").Linter.Config[]} */
export default [
  ...config,
  {
    linterOptions: {
      // Disabled because rules turned off below leave behind eslint-disable
      // directives that would otherwise produce noise. Track separately.
      reportUnusedDisableDirectives: false,
    },
    rules: {
      // N6 audit finding (2026-04-06): downgraded from "off" to "warn" so
      // lint catches NEW violations. The package `lint` script enforces a
      // ceiling via `--max-warnings <N>` set just above current debt.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": "warn",
      "no-useless-escape": "off",
      "no-control-regex": "off",
      "turbo/no-undeclared-env-vars": "off",
    },
  },
  {
    ignores: ["dist/**", "coverage/**"],
  },
];

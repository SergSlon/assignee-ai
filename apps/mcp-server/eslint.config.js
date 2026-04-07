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
      // Tracked debt — see CI hardening story.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "no-useless-escape": "off",
      "no-control-regex": "off",
      "turbo/no-undeclared-env-vars": "off",
    },
  },
  {
    ignores: ["dist/**", "coverage/**"],
  },
];

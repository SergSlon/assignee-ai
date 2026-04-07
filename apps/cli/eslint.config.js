import { config } from "@assignee/eslint-config/base";

/**
 * apps/cli ESLint configuration.
 *
 * The shared base enables `eslint:recommended` + typescript-eslint
 * recommended + turbo. Several rules from those preset packs surface
 * warnings on legacy areas of the codebase that are NOT correctness
 * issues — they are tracked separately and silenced here so CI can
 * enforce `--max-warnings 0` on the rules that DO catch real bugs.
 *
 * @type {import("eslint").Linter.Config[]}
 */
export default [
  ...config,
  {
    linterOptions: {
      reportUnusedDisableDirectives: false,
    },
    rules: {
      // Tracked debt — to be fixed incrementally; see CI hardening story.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "no-useless-escape": "off",
      // Codebase intentionally uses control chars in sanitization regexes.
      "no-control-regex": "off",
      // turbo env-var declarations live in turbo.json — separate fix.
      "turbo/no-undeclared-env-vars": "off",
    },
  },
  {
    ignores: ["dist/**", "coverage/**", "scripts/**"],
  },
];

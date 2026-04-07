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
      // N6 audit finding (2026-04-06): these were previously "off" which
      // gave a false signal that lint enforces strict types. They are now
      // "warn" so the lint pipeline can catch NEW violations via the
      // package's `lint` script (`--max-warnings <ceiling>`). The ceiling
      // is set just above the current debt count so CI fails on regressions
      // while we burn down the existing list. To clear remaining debt, fix
      // the warnings reported by `pnpm lint` and lower the ceiling.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": "warn",
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

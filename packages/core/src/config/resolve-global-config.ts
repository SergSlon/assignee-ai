/**
 * resolve-global-config.ts — merges global (non-per-resource) config from
 * all 5 precedence levels into a single AssigneeConfig with required
 * preferences.
 *
 * Resource-level field overrides (per-resource-type wizard answers) are
 * a separate concern handled by mergeConfigs() in apps/cli. This module
 * is only for the top-level knobs: defaults, preferences, budget,
 * org_policy. Most importantly, it exists so ASSIGNEE_* environment
 * variables produced by loadEnvOverrides() actually take effect at
 * runtime — before this helper the loader was dead code.
 *
 * Precedence (highest wins):
 *
 *   1. CLI flags              — `--auto-fix=apply` etc.
 *   2. Environment variables  — `ASSIGNEE_AUTO_FIX`, `ASSIGNEE_VERBOSITY`, ...
 *   3. Project config         — `./.assignee/config.yaml`
 *   4. User config            — `~/.config/assignee/config.yaml`
 *   5. CONFIG_DEFAULTS        — `{auto_fix: "ask", output_format: "table", ...}`
 *
 * Missing sources are fine; the helper is safe to call with an empty
 * object and will return CONFIG_DEFAULTS-only preferences.
 *
 * @see A2 sprint slice — config precedence formalization (2026-04-08)
 */

import {
  CONFIG_DEFAULTS,
  type AssigneeConfig,
  type ConfigPreferences,
  type ConfigDefaults,
  type ConfigBudget,
} from "./config-schema.js";

/** Per-level source container passed to resolveGlobalConfig. */
export interface GlobalConfigSources {
  /** Level 1 — CLI flags (highest precedence) */
  cliFlags?: Partial<AssigneeConfig>;
  /** Level 2 — ASSIGNEE_* environment variables */
  envOverrides?: Partial<AssigneeConfig>;
  /** Level 3 — ./.assignee/config.yaml */
  projectConfig?: Partial<AssigneeConfig>;
  /** Level 4 — ~/.config/assignee/config.yaml */
  userConfig?: Partial<AssigneeConfig>;
}

/**
 * Return type: AssigneeConfig with `preferences` guaranteed to be fully
 * populated (so callers never need nullish-coalescing on individual
 * preference fields).
 */
export interface ResolvedGlobalConfig extends AssigneeConfig {
  preferences: Required<ConfigPreferences>;
}

/**
 * Resolve a merged global config from the 5 precedence levels above.
 *
 * - `preferences` is always present and fully populated from
 *   CONFIG_DEFAULTS ∪ all provided sources.
 * - `defaults` is present only when at least one source contributed
 *   a key to it; keys from higher-priority sources overwrite
 *   lower-priority ones (shallow merge).
 * - `budget` follows the same rule as `defaults`.
 * - `org_policy` is passed through from the highest-priority source
 *   that defines it — org policy is not shallow-merged because the
 *   per-resource-type key semantics would make partial merges
 *   surprising.
 *
 * The helper is pure and has zero I/O; callers are responsible for
 * loading each source and shaping it as `Partial<AssigneeConfig>`.
 */
export function resolveGlobalConfig(
  sources: GlobalConfigSources,
): ResolvedGlobalConfig {
  // Level 5 ∪ 4 ∪ 3 ∪ 2 ∪ 1 — later entries overwrite earlier ones.
  const preferences: Required<ConfigPreferences> = {
    ...CONFIG_DEFAULTS,
    ...sources.userConfig?.preferences,
    ...sources.projectConfig?.preferences,
    ...sources.envOverrides?.preferences,
    ...sources.cliFlags?.preferences,
  };

  const defaults: ConfigDefaults = {
    ...sources.userConfig?.defaults,
    ...sources.projectConfig?.defaults,
    ...sources.envOverrides?.defaults,
    ...sources.cliFlags?.defaults,
  };
  // Nested naming: merge shallowly so a userConfig prefix isn't wiped
  // out by an envOverrides suffix-only definition.
  const userNaming = sources.userConfig?.defaults?.naming;
  const projectNaming = sources.projectConfig?.defaults?.naming;
  const envNaming = sources.envOverrides?.defaults?.naming;
  const cliNaming = sources.cliFlags?.defaults?.naming;
  if (userNaming || projectNaming || envNaming || cliNaming) {
    defaults.naming = {
      ...userNaming,
      ...projectNaming,
      ...envNaming,
      ...cliNaming,
    };
  }
  // Nested tags: merge shallowly by key so tags defined at different
  // levels don't wipe each other out.
  const userTags = sources.userConfig?.defaults?.tags;
  const projectTags = sources.projectConfig?.defaults?.tags;
  const envTags = sources.envOverrides?.defaults?.tags;
  const cliTags = sources.cliFlags?.defaults?.tags;
  if (userTags || projectTags || envTags || cliTags) {
    defaults.tags = {
      ...userTags,
      ...projectTags,
      ...envTags,
      ...cliTags,
    };
  }

  const budget: ConfigBudget | undefined =
    sources.userConfig?.budget ||
    sources.projectConfig?.budget ||
    sources.envOverrides?.budget ||
    sources.cliFlags?.budget
      ? {
          ...sources.userConfig?.budget,
          ...sources.projectConfig?.budget,
          ...sources.envOverrides?.budget,
          ...sources.cliFlags?.budget,
        }
      : undefined;

  // org_policy: take the highest-priority source that defines it,
  // don't try to merge. Per-resource-type keys would make a shallow
  // merge surprising and a deep merge unsafe.
  const orgPolicy =
    sources.cliFlags?.org_policy ??
    sources.envOverrides?.org_policy ??
    sources.projectConfig?.org_policy ??
    sources.userConfig?.org_policy;

  const hasDefaults = Object.keys(defaults).length > 0;

  const result: ResolvedGlobalConfig = { preferences };
  if (hasDefaults) result.defaults = defaults;
  if (budget) result.budget = budget;
  if (orgPolicy) result.org_policy = orgPolicy;
  return result;
}

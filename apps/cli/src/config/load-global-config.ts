/**
 * load-global-config.ts — CLI-side composition of the global config
 * resolver. Loads environment overrides, adapts the legacy UserConfig
 * shape into `AssigneeConfig`, and feeds both into
 * `resolveGlobalConfig()` from @assignee/core.
 *
 * Before A2 (2026-04-08), `loadEnvOverrides()` existed but was never
 * called from production code — setting `ASSIGNEE_AUTO_FIX=apply` in
 * a CI environment had no effect at runtime. This module closes that
 * gap: the resolved config is plumbed into graph state as
 * `resolvedConfig`, and `fix-applicator` reads its preferences.
 *
 * Project-config.yaml is NOT yet loaded here. The existing project
 * config loader produces a per-resource-type override map (not an
 * AssigneeConfig), so wiring it as a third source would require
 * reshaping the project yaml — deliberately out of scope for this
 * slice. When project yaml grows `defaults`/`preferences`/`budget`
 * keys, they can be fed into `resolveGlobalConfig({projectConfig})`
 * without touching any existing call site.
 *
 * @see A2 sprint slice — config precedence
 */

import {
  resolveGlobalConfig,
  AutoFixMode,
  type AssigneeConfig,
  type ResolvedGlobalConfig,
} from "@assignee/core";
import { loadEnvOverrides } from "./env-overrides.js";
import type { UserConfig } from "./user-config-loader.js";

/**
 * Adapt a legacy `UserConfig` (the shape loaded by
 * `apps/cli/src/config/user-config-loader.ts`) into the
 * `AssigneeConfig` shape that `resolveGlobalConfig()` expects.
 *
 * Precedence inside the user config itself:
 *   1. A user YAML that already uses the new `preferences:` key wins
 *      verbatim. `user-config-loader.ts` validates the legacy keys
 *      strictly but tolerates extra top-level keys as opaque records,
 *      so `preferences:` passes through untouched.
 *   2. Otherwise fall back to the legacy `bestPractices.autoFix`
 *      boolean, translating `true → apply` and `false → ask`.
 *   3. Otherwise return undefined so the helper sees no user source.
 */
export function adaptUserConfigToAssignee(
  uc: UserConfig | undefined,
): Partial<AssigneeConfig> | undefined {
  if (!uc) return undefined;

  // Opaque passthrough: if the user's YAML already uses the new
  // AssigneeConfig shape, honor it verbatim.
  const raw = uc as unknown as Partial<AssigneeConfig>;
  if (raw.preferences || raw.defaults || raw.budget) {
    const result: Partial<AssigneeConfig> = {};
    if (raw.preferences) result.preferences = raw.preferences;
    if (raw.defaults) result.defaults = raw.defaults;
    if (raw.budget) result.budget = raw.budget;
    return result;
  }

  // Legacy translation: bestPractices.autoFix boolean → preferences.auto_fix.
  const autoFix = uc.bestPractices?.autoFix;
  if (autoFix !== undefined) {
    return {
      preferences: {
        auto_fix: autoFix ? AutoFixMode.APPLY : AutoFixMode.ASK,
      },
    };
  }

  return undefined;
}

/**
 * Compose the final resolved global config from:
 *   - env overrides  (`ASSIGNEE_*` variables)
 *   - user config    (adapted from legacy UserConfig)
 *
 * CLI flags and project yaml are not yet wired; add them as extra
 * sources on the `resolveGlobalConfig()` call when the upstream
 * loaders exist in `AssigneeConfig` shape.
 */
export function loadGlobalConfig(
  userConfig: UserConfig | undefined,
): ResolvedGlobalConfig {
  return resolveGlobalConfig({
    envOverrides: loadEnvOverrides(),
    userConfig: adaptUserConfigToAssignee(userConfig),
  });
}

/**
 * load-global-config.ts — CLI-side composition of the global config
 * resolver. Loads environment overrides, the project YAML (via
 * `loadProjectConfig()`), and adapts the legacy UserConfig shape,
 * then feeds all three into `resolveGlobalConfig()` from
 * @assignee/core.
 *
 * Before A2 (2026-04-08), `loadEnvOverrides()` existed but was never
 * called from production code — setting `ASSIGNEE_AUTO_FIX=apply` in
 * a CI environment had no effect at runtime. This module closes that
 * gap: the resolved config is plumbed into graph state as
 * `resolvedConfig`, and `fix-applicator` reads its preferences.
 *
 * A5 (post-A2, same session) — project YAML is now wired as a
 * `resolveGlobalConfig({projectConfig})` source. `loadProjectConfig()`
 * already returns the validated `AssigneeConfig` shape (it calls
 * `validateConfig()` from @assignee/core), so the wire-up is a
 * single async call. Precedence still matches the A2 design:
 * env > projectYaml > userYaml > CONFIG_DEFAULTS.
 *
 * @see A2 / A5 sprint slices — config precedence
 */

import {
  resolveGlobalConfig,
  AutoFixMode,
  type AssigneeConfig,
  type ResolvedGlobalConfig,
} from "@assignee/core";
import { loadEnvOverrides } from "./env-overrides.js";
import { loadProjectConfig } from "./project-config-loader.js";
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
 *   - project config (`./.assignee/config.yaml` — A5 addition)
 *   - user config    (adapted from legacy UserConfig)
 *
 * CLI flags are not yet wired; add them as an extra source on the
 * `resolveGlobalConfig()` call when `--auto-fix=apply` / etc.
 * surface as Commander `.option()` entries.
 *
 * Async because `loadProjectConfig()` walks the filesystem for
 * `.assignee/config.yaml`. The legacy synchronous call sites that
 * only needed env + user config can continue to compose
 * `resolveGlobalConfig()` directly if they need a sync path.
 */
export async function loadGlobalConfig(
  userConfig: UserConfig | undefined,
): Promise<ResolvedGlobalConfig> {
  const projectConfig = await loadProjectConfig();
  return resolveGlobalConfig({
    envOverrides: loadEnvOverrides(),
    projectConfig,
    userConfig: adaptUserConfigToAssignee(userConfig),
  });
}

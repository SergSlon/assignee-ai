/**
 * Auto-fix mode resolver.
 *
 * A2 (2026-04-08): reads from state.resolvedConfig.preferences.auto_fix,
 * which is produced by `loadGlobalConfig()` at CLI command boot and
 * merges (highest wins) CLI flags → env vars (ASSIGNEE_AUTO_FIX) →
 * project yaml → user yaml → CONFIG_DEFAULTS. Falls back to the
 * legacy `state.userConfig.preferences.auto_fix` loose read for
 * backward compatibility.
 *
 * Preserves the 3-mode contract (feedback_autofix_user_decides):
 *   "ask"   → interactive fix-selection prompt
 *   "apply" → auto-fixes applied silently (CI/CD)
 *   "skip"  → auto-fixes disabled entirely
 *
 * Wave-6c F3: extracted from fix-applicator.ts (SRP).
 */

import { AutoFixMode } from "@assignee/core";
import type { AgentState } from "../../graph-state.js";

/** Resolve auto-fix mode from graph state. */
export function resolveAutoFixMode(state: AgentState): string {
  const fromResolved = state.resolvedConfig?.preferences?.auto_fix;
  if (fromResolved) return fromResolved;
  const legacy = state.userConfig as
    | { preferences?: { auto_fix?: string } }
    | undefined;
  return legacy?.preferences?.auto_fix ?? AutoFixMode.ASK;
}

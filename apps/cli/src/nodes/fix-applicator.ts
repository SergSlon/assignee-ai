/**
 * fix_applicator node — applies auto-fixable best practice patches to desiredState.
 *
 * Positioned between bp_evaluator and preflight_guard. Reads autoFixBestPractices
 * preference from project config (.assignee/config.yaml). When enabled, applies
 * desiredStatePatch from auto-fixable findings to desiredState, respecting user's
 * explicit wizard choices (elicitedOptions).
 *
 * @see Story 22.2, Epic 22
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import * as clack from "@clack/prompts";
import type { BPFinding } from "@assignee/best-practices";
import type { AgentState } from "../services/graph.js";
import type { AppliedFix } from "../services/graph-state.js";
import { log, LOG_ACTIONS } from "../utils/logger.js";
import { wizardKeyMap } from "../utils/wizard-key-map.js";

/** Directory name for project-level config. */
const CONFIG_DIR = ".assignee";
const CONFIG_FILE = "config.yaml";

/**
 * Read the autoFixBestPractices preference from project config.
 * Returns false if config is missing or preference is unset.
 */
function readAutoFixPreference(projectDir?: string): boolean {
  try {
    const configPath = path.resolve(
      projectDir ?? process.cwd(),
      CONFIG_DIR,
      CONFIG_FILE,
    );
    const content = fs.readFileSync(configPath, "utf-8");
    const parsed = parseYaml(content) as Record<string, unknown> | null;
    const val = parsed?.["autoFixBestPractices"];
    return val === true || val === "true";
  } catch {
    return false;
  }
}

/**
 * Deep-merge a patch object into a target object.
 * Arrays in the patch are merged element-by-element (patch[i] merged into target[i]).
 * Scalar values in the patch overwrite the target.
 */
function deepMergePatch(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };

  for (const [key, patchValue] of Object.entries(patch)) {
    // Prototype pollution guard: reject __proto__, constructor, prototype keys
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      continue;
    }
    const targetValue = result[key];

    if (Array.isArray(patchValue) && Array.isArray(targetValue)) {
      // Merge arrays element-by-element
      const merged = [...targetValue];
      for (let i = 0; i < patchValue.length; i++) {
        if (
          i < merged.length &&
          typeof merged[i] === "object" &&
          merged[i] !== null &&
          typeof patchValue[i] === "object" &&
          patchValue[i] !== null &&
          !Array.isArray(patchValue[i])
        ) {
          merged[i] = deepMergePatch(
            merged[i] as Record<string, unknown>,
            patchValue[i] as Record<string, unknown>,
          );
        } else if (i < merged.length) {
          // Patch scalar onto existing element — wrap into merge if both are objects
          merged[i] = patchValue[i];
        } else {
          merged.push(patchValue[i]);
        }
      }
      result[key] = merged;
    } else if (
      typeof patchValue === "object" &&
      patchValue !== null &&
      !Array.isArray(patchValue) &&
      typeof targetValue === "object" &&
      targetValue !== null &&
      !Array.isArray(targetValue)
    ) {
      // Deep merge nested objects
      result[key] = deepMergePatch(
        targetValue as Record<string, unknown>,
        patchValue as Record<string, unknown>,
      );
    } else {
      result[key] = patchValue;
    }
  }

  return result;
}

/**
 * Check if the user explicitly set a field that a patch would modify.
 * Walks the patch keys and checks if elicitedOptions contains a matching key path.
 */
function isFieldExplicitlySet(
  elicitedOptions: Record<string, unknown> | undefined,
  patch: Record<string, unknown>,
): boolean {
  if (!elicitedOptions) return false;

  for (const key of Object.keys(patch)) {
    if (key in elicitedOptions) return true;

    // Check nested: if patch has { BlockDeviceMappings: [...] } and elicited has { EbsEncrypted: ... }
    // Uses shared wizardKeyMap (Story 35.1)
    const wizardKeys = wizardKeyMap[key];
    if (wizardKeys === undefined) {
      // Unknown patch key not in wizardKeyMap — check if the key itself
      // was directly set by the user. Only block if it was.
      if (key in elicitedOptions) return true;
      continue;
    }
    if (wizardKeys.some((wk) => wk in elicitedOptions)) {
      return true;
    }
  }

  return false;
}

/**
 * Extract the "old value" from desiredState by walking the same nested path
 * as the patch, so the display shows the actual value being replaced (leaf),
 * not the entire top-level object.
 */
function extractOldValue(
  desiredState: Record<string, unknown>,
  patch: Record<string, unknown>,
): unknown {
  let current: unknown = desiredState;
  let patchLevel: unknown = patch;

  while (
    typeof patchLevel === "object" &&
    patchLevel !== null &&
    !Array.isArray(patchLevel)
  ) {
    const keys = Object.keys(patchLevel as Record<string, unknown>);
    if (keys.length === 0) break;
    const key = keys[0]!;
    const nextPatch = (patchLevel as Record<string, unknown>)[key];
    if (typeof current === "object" && current !== null && !Array.isArray(current)) {
      current = (current as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
    // If the next level of the patch is a scalar, we've found the leaf — return current
    if (typeof nextPatch !== "object" || nextPatch === null || Array.isArray(nextPatch)) {
      return current;
    }
    patchLevel = nextPatch;
  }

  return current;
}

/**
 * Extract the "new value" (first leaf) from a patch for display.
 */
function extractNewValue(patch: Record<string, unknown>): unknown {
  const firstKey = Object.keys(patch)[0];
  if (!firstKey) return undefined;
  const val = patch[firstKey];
  if (typeof val === "object" && val !== null && !Array.isArray(val)) {
    return extractNewValue(val as Record<string, unknown>);
  }
  return val;
}

/**
 * Extract the field path description from a patch for display.
 */
function extractFieldPath(patch: Record<string, unknown>): string {
  const parts: string[] = [];
  let current: unknown = patch;

  while (
    typeof current === "object" &&
    current !== null &&
    !Array.isArray(current)
  ) {
    const keys = Object.keys(current as Record<string, unknown>);
    if (keys.length === 0) break;
    parts.push(keys[0]!);
    current = (current as Record<string, unknown>)[keys[0]!];
  }

  return parts.join(".");
}

/**
 * Check if every key-value in a patch already exists in the target state.
 * Walks the patch tree recursively and compares leaf values.
 */
function isPatchAlreadyApplied(
  state: Record<string, unknown>,
  patch: Record<string, unknown>,
): boolean {
  for (const [key, patchValue] of Object.entries(patch)) {
    const stateValue = state[key];
    if (typeof patchValue === "object" && patchValue !== null && !Array.isArray(patchValue)) {
      if (typeof stateValue !== "object" || stateValue === null || Array.isArray(stateValue)) {
        return false;
      }
      if (!isPatchAlreadyApplied(stateValue as Record<string, unknown>, patchValue as Record<string, unknown>)) {
        return false;
      }
    } else {
      // Compare with JSON for arrays/primitives
      if (JSON.stringify(stateValue) !== JSON.stringify(patchValue)) {
        return false;
      }
    }
  }
  return true;
}

/**
 * fix_applicator graph node.
 *
 * Applies auto-fixable best practice patches when the user has opted in.
 * Findings that are auto-fixed are removed from bpFindings; only residual
 * findings are passed to preflight_guard.
 *
 * @param state - Current graph state after bp_evaluator
 * @returns Partial state update with patched desiredState, appliedFixes, and residual bpFindings
 */
export async function fixApplicatorNode(
  state: AgentState,
): Promise<Partial<AgentState>> {
  const findings = state.bpFindings ?? [];
  const desiredState = (state.desiredState as Record<string, unknown>) ?? {};

  // No findings → pass through
  if (findings.length === 0) {
    return {};
  }

  const autoFixEnabled = readAutoFixPreference(state.projectDir);

  const autoFixable = autoFixEnabled
    ? findings.filter((f) => f.autoFixable && f.desiredStatePatch)
    : [];

  // Interactive findings are user-driven — not gated behind autoFixBestPractices
  const hasInteractive = findings.some(
    (f) =>
      f.fixType === "interactive" &&
      f.interactiveOptions &&
      f.interactiveOptions.length > 0,
  );

  // Nothing to do → pass through
  if (autoFixable.length === 0 && !hasInteractive) {
    return { appliedFixes: [], autoFixEnabled };
  }

  const appliedFixes: AppliedFix[] = [];
  // Keep original for oldValue lookups; mutations go to patchedState
  const originalState = { ...desiredState };
  let patchedState = { ...desiredState };
  const fixedPracticeIds = new Set<string>();
  const userChoicePracticeIds = new Set<string>();
  const skippedPracticeIds = new Set<string>();

  for (const finding of autoFixable) {
    // Skip if already satisfied by an earlier fix (dedup overlapping BPs)
    if (fixedPracticeIds.has(finding.practiceId)) continue;
    const patch = finding.desiredStatePatch!;

    // Story 22.5: Skip if user explicitly set this field in the wizard
    if (isFieldExplicitlySet(state.elicitedOptions, patch)) {
      userChoicePracticeIds.add(finding.practiceId);
      continue;
    }

    // Check if this patch is already satisfied by a prior fix.
    // Compare the full patch JSON against the same key path in patchedState
    // to avoid first-leaf-only comparison bugs with multi-sub-key objects.
    if (isPatchAlreadyApplied(patchedState, patch)) {
      fixedPracticeIds.add(finding.practiceId);
      continue;
    }

    // Read old value from ORIGINAL state, not already-patched state
    const oldValue = extractOldValue(originalState, patch);
    patchedState = deepMergePatch(patchedState, patch);

    appliedFixes.push({
      practiceId: finding.practiceId,
      title: finding.title,
      fieldPath: extractFieldPath(patch),
      oldValue,
      newValue: extractNewValue(patch),
    });

    fixedPracticeIds.add(finding.practiceId);
  }

  // Story 22.4: Handle Type B interactive fixes (TTY only)
  const interactiveFindings = findings.filter(
    (f) =>
      f.fixType === "interactive" &&
      f.interactiveOptions &&
      f.interactiveOptions.length > 0 &&
      !fixedPracticeIds.has(f.practiceId),
  );

  if (interactiveFindings.length > 0 && !process.stdin.isTTY) {
    log({
      ts: new Date().toISOString(),
      runId: state.runId,
      level: "info",
      action: LOG_ACTIONS.FIX_APPLIED,
      extras: {
        skippedInteractive: interactiveFindings.length,
        reason: "non-TTY environment — interactive prompts unavailable",
        practiceIds: interactiveFindings.map((f) => f.practiceId),
      },
    });
  }

  if (interactiveFindings.length > 0 && process.stdin.isTTY) {
    for (const finding of interactiveFindings) {
      const options = finding.interactiveOptions!;
      const severityLabel = finding.severity;

      const selected = await clack.select({
        message: `${severityLabel}: ${finding.title}`,
        options: options.map((opt, i) => ({
          value: i,
          label: `[${i + 1}] ${opt.label}`,
        })),
      });

      if (clack.isCancel(selected)) continue;

      const option = options[selected as number];
      if (!option) continue;

      if (option.action === "prompt_value" && option.targetField) {
        const value = await clack.text({
          message: `Enter value for ${option.targetField}:`,
          validate: (v) => (!v || v.trim().length === 0 ? "Value cannot be empty" : undefined),
        });

        if (!clack.isCancel(value) && value) {
          patchedState[option.targetField] = value as string;
          appliedFixes.push({
            practiceId: finding.practiceId,
            title: finding.title,
            fieldPath: option.targetField,
            oldValue: undefined,
            newValue: value as string,
          });
          fixedPracticeIds.add(finding.practiceId);
        } else if (!clack.isCancel(value)) {
          // Empty value after validation bypass — treat as skip
          skippedPracticeIds.add(finding.practiceId);
        }
      } else if (option.action === "prompt_value" && !option.targetField) {
        // Misconfigured option — no targetField to write to; skip
        skippedPracticeIds.add(finding.practiceId);
      } else if (option.action === "set_value" && option.targetField) {
        // Set a predefined value (e.g., ConnectivityType → "private")
        const oldVal = patchedState[option.targetField];
        patchedState[option.targetField] = option.targetValue;
        appliedFixes.push({
          practiceId: finding.practiceId,
          title: finding.title,
          fieldPath: option.targetField,
          oldValue: oldVal,
          newValue: option.targetValue,
        });
        fixedPracticeIds.add(finding.practiceId);
      } else if (option.action === "remove_property" && option.targetField) {
        // Remove a property from desiredState (e.g., remove GatewayId)
        const oldVal = patchedState[option.targetField];
        delete patchedState[option.targetField];
        appliedFixes.push({
          practiceId: finding.practiceId,
          title: finding.title,
          fieldPath: option.targetField,
          oldValue: oldVal,
          newValue: undefined,
        });
        fixedPracticeIds.add(finding.practiceId);
      } else if (option.action === "skip") {
        skippedPracticeIds.add(finding.practiceId);
      }
    }
  }

  // Residual findings = findings NOT auto-fixed (clone to avoid mutating state)
  const residualFindings: BPFinding[] = findings
    .filter((f) => !fixedPracticeIds.has(f.practiceId))
    .map((f) => ({
      ...f,
      ...(userChoicePracticeIds.has(f.practiceId)
        ? { userExplicitChoice: true }
        : {}),
      ...(skippedPracticeIds.has(f.practiceId) ? { userSkipped: true } : {}),
    }));

  if (appliedFixes.length > 0) {
    log({
      ts: new Date().toISOString(),
      runId: state.runId,
      level: "info",
      action: LOG_ACTIONS.FIX_APPLIED,
      extras: {
        resourceType: state.resourceType,
        fixedCount: appliedFixes.length,
        residualCount: residualFindings.length,
        practiceIds: appliedFixes.map((f) => f.practiceId),
      },
    });
  }

  return {
    desiredState: patchedState,
    bpFindings: residualFindings,
    appliedFixes,
    autoFixEnabled: true,
  };
}

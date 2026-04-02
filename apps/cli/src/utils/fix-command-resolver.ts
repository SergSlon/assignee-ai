/**
 * FixCommandResolver — derives actionable fix hints from BPFinding data.
 *
 * Takes a BPFinding + resourceType and returns a structured FindingAction
 * describing what category of fix it is and how to display it.
 *
 * Four categories:
 * - auto-fixable: has desiredStatePatch, will be applied automatically
 * - wizard-fixable: property_path root key is in wizardKeyMap → --set flag
 * - manual: CFN property exists but no wizard field → show guidance
 * - awareness: check_type is awareness/cross_resource or no property_path
 *
 * @see Story 35.2, Epic 35
 */

import type { BPFinding } from "@assignee/best-practices";
import {
  wizardKeyMap,
  toSetFlag,
  toSetFlagFromPatch,
} from "./wizard-key-map.js";

/**
 * Named constants for fix categories — eliminates magic strings in comparisons.
 *
 * @see Story 42.10 — zero magic strings policy
 */
export const FixCategory = {
  AUTO_FIXABLE: "auto-fixable",
  WIZARD_FIXABLE: "wizard-fixable",
  MANUAL: "manual",
  AWARENESS: "awareness",
} as const;

export type FixCategoryType = (typeof FixCategory)[keyof typeof FixCategory];

export interface FindingAction {
  category: FixCategoryType;
  fixable: boolean;
  command?: string;
  hint: string;
  patch?: Record<string, unknown>;
}

/**
 * Resolve the actionable fix for a given finding.
 *
 * Resolution order:
 * 1. Auto-fixable (autoFixable + desiredStatePatch)
 * 2. Wizard-fixable (property_path root key in wizardKeyMap)
 * 3. Manual (has property_path but no wizard mapping)
 * 4. Awareness (no actionable fix)
 */
export function resolveAction(finding: BPFinding): FindingAction {
  // Category A: Auto-fixable — must have a non-empty patch
  if (
    finding.autoFixable &&
    finding.desiredStatePatch &&
    Object.keys(finding.desiredStatePatch).length > 0
  ) {
    const patchKeys = Object.keys(finding.desiredStatePatch);
    // Use toSetFlagFromPatch to match the specific sub-key, not just the first wizard field
    const flagField =
      patchKeys.length > 0
        ? toSetFlagFromPatch(patchKeys[0]!, finding.desiredStatePatch)
        : null;
    const command = flagField
      ? `--set ${flagField}=${formatPatchValue(finding.desiredStatePatch, patchKeys[0]!)}`
      : undefined;

    return {
      category: FixCategory.AUTO_FIXABLE,
      fixable: true,
      command,
      hint: command ? command : "Applied automatically when enabled",
      patch: finding.desiredStatePatch,
    };
  }

  // Category D: Awareness-only (check before wizard-fixable since these can't be fixed)
  if (finding.fixType === "info") {
    return {
      category: FixCategory.AWARENESS,
      fixable: false,
      hint: finding.fixHint ?? finding.remediation ?? "Check after deployment",
    };
  }

  // For findings with no/empty propertyPath, treat as awareness
  if (!finding.propertyPath || finding.propertyPath.length === 0) {
    return {
      category: FixCategory.AWARENESS,
      fixable: false,
      hint: finding.fixHint ?? finding.remediation ?? "Check after deployment",
    };
  }

  // Category B: Wizard-fixable — only if a desiredStatePatch exists to apply
  if (
    finding.fixType === "interactive" &&
    finding.interactiveOptions?.length &&
    finding.desiredStatePatch &&
    Object.keys(finding.desiredStatePatch).length > 0
  ) {
    const label = finding.interactiveOptions[0]?.label;
    return {
      category: FixCategory.WIZARD_FIXABLE,
      fixable: true,
      hint: finding.fixHint ?? label ?? "Select an option to fix",
    };
  }

  // Wizard-fixable via wizardKeyMap — only fixable if there's a patch to apply
  const rootKey = finding.propertyPath.split(".")[0]!.replace(/\[\d+\]$/, "");
  const setFlag = toSetFlag(rootKey);
  if (setFlag && finding.desiredStatePatch) {
    return {
      category: FixCategory.WIZARD_FIXABLE,
      fixable: true,
      command: `--set ${setFlag}=<value>`,
      hint: finding.fixHint ?? `Fix: --set ${setFlag}=<value>`,
    };
  }

  // Has wizard mapping but no patch — show as manual guidance (user must --set manually)
  if (setFlag) {
    return {
      category: FixCategory.MANUAL,
      fixable: false,
      command: `--set ${setFlag}=<value>`,
      hint: finding.fixHint ?? `--set ${setFlag}=<value>`,
    };
  }

  // Category C: Manual — has property_path but no wizard mapping
  return {
    category: FixCategory.MANUAL,
    fixable: false,
    hint:
      finding.fixHint ??
      finding.remediation ??
      `Set ${finding.propertyPath} in AWS console or CloudFormation`,
  };
}

/**
 * Extract a display-friendly leaf value from a patch for the first key.
 * Drills into nested objects to find the first scalar value.
 */
function formatPatchValue(patch: Record<string, unknown>, key: string): string {
  let val: unknown = patch[key];
  // Drill into nested objects/arrays to find a leaf scalar
  for (let depth = 0; depth < 10; depth++) {
    if (val === null || val === undefined) return "true";
    if (typeof val === "boolean") return String(val);
    if (typeof val === "string" || typeof val === "number") return String(val);
    if (Array.isArray(val)) {
      val = val[0];
      continue;
    }
    if (typeof val === "object") {
      const keys = Object.keys(val as Record<string, unknown>);
      if (keys.length === 0) return "true";
      val = (val as Record<string, unknown>)[keys[0]!];
      continue;
    }
    break;
  }
  return "true";
}

/**
 * Count fixable findings in a set of findings.
 */
export function countFixable(findings: BPFinding[]): number {
  return findings.filter((f) => resolveAction(f).fixable).length;
}

/**
 * Count auto-fixable findings (subset of fixable).
 */
export function countAutoFixable(findings: BPFinding[]): number {
  return findings.filter(
    (f) => resolveAction(f).category === FixCategory.AUTO_FIXABLE,
  ).length;
}

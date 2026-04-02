/**
 * Interactive fix selection — prompts user to address fixable findings after plan display.
 * Extracted from display.ts (Story 35.4) to keep display.ts focused on rendering.
 *
 * @see Story 35.4, Epic 35
 */

import * as clack from "@clack/prompts";
import type { BPFinding } from "@assignee/best-practices";
import type { AppliedFix } from "../services/graph-state.js";
import { resolveAction } from "./fix-command-resolver.js";
import { PROTO_POLLUTION_KEYS, UNKNOWN_FALLBACK } from "../config/constants.js";

/** Prompt action constants for fix selection. */
const FixPromptAction = {
  ALL: "all",
  CHOOSE: "choose",
  SKIP: "skip",
  FIX: "fix",
} as const;

export interface FixSelectionResult {
  desiredState: Record<string, unknown>;
  bpFindings: BPFinding[];
  appliedFixes: AppliedFix[];
}

/** State shape needed by fix selection (subset of RenderableState). */
export interface FixSelectionState {
  desiredState?: Record<string, unknown>;
  bpFindings?: BPFinding[];
  appliedFixes?: AppliedFix[];
  autoApprove?: boolean;
}

/**
 * Deep-merge a patch into a target. Nested objects merged recursively;
 * arrays merged element-by-element. Matches fix-applicator's deepMergePatch.
 */
function deepMergePatch(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };
  for (const [key, patchValue] of Object.entries(patch)) {
    if (PROTO_POLLUTION_KEYS.has(key)) continue;
    const targetValue = result[key];
    if (Array.isArray(patchValue) && Array.isArray(targetValue)) {
      const merged = [...targetValue];
      for (let i = 0; i < patchValue.length; i++) {
        if (
          i < merged.length &&
          typeof merged[i] === "object" &&
          merged[i] !== null &&
          !Array.isArray(merged[i]) &&
          typeof patchValue[i] === "object" &&
          patchValue[i] !== null &&
          !Array.isArray(patchValue[i])
        ) {
          merged[i] = deepMergePatch(
            merged[i] as Record<string, unknown>,
            patchValue[i] as Record<string, unknown>,
          );
        } else if (i < merged.length) {
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

/** Extract the first leaf scalar from a nested patch. */
function extractPatchLeaf(patch: Record<string, unknown>): unknown {
  let current: unknown = patch;
  for (let depth = 0; depth < 10; depth++) {
    if (current === null || current === undefined) return current;
    if (typeof current !== "object" || Array.isArray(current)) return current;
    const keys = Object.keys(current as Record<string, unknown>);
    if (keys.length === 0) return current;
    current = (current as Record<string, unknown>)[keys[0]!];
  }
  return current;
}

/** Get a value from a nested object by dot-notation path. */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  if (!path) return undefined;
  let current: unknown = obj;
  for (const segment of path.split(".")) {
    if (
      current === null ||
      current === undefined ||
      typeof current !== "object"
    )
      return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Extract the dot-notation field path from a patch object. */
function extractPatchFieldPath(patch: Record<string, unknown>): string {
  const parts: string[] = [];
  let current: unknown = patch;
  for (let depth = 0; depth < 10; depth++) {
    if (
      typeof current !== "object" ||
      current === null ||
      Array.isArray(current)
    )
      break;
    const keys = Object.keys(current as Record<string, unknown>);
    if (keys.length === 0) break;
    parts.push(keys[0]!);
    current = (current as Record<string, unknown>)[keys[0]!];
  }
  return parts.join(".");
}

/**
 * Prompt user to fix findings interactively (TTY only).
 * Returns updated state if fixes applied, null otherwise.
 */
export async function promptFixSelection(
  state: FixSelectionState,
): Promise<FixSelectionResult | null> {
  if (!process.stdin.isTTY || state.autoApprove) return null;

  const items = state.bpFindings ?? [];
  if (items.length === 0) return null;

  const fixableFindings = items.filter((f) => {
    const action = resolveAction(f);
    return (
      action.fixable &&
      f.desiredStatePatch &&
      Object.keys(f.desiredStatePatch).length > 0
    );
  });

  if (fixableFindings.length === 0) return null;

  const desiredState = JSON.parse(
    JSON.stringify(state.desiredState ?? {}),
  ) as Record<string, unknown>;
  const newAppliedFixes: AppliedFix[] = [...(state.appliedFixes ?? [])];
  const fixedIds = new Set<string>();

  try {
    const choice = await clack.select({
      message: `${fixableFindings.length} finding${fixableFindings.length === 1 ? "" : "s"} can be fixed. Would you like to address them?`,
      options: [
        {
          value: FixPromptAction.ALL,
          label: "[1] Fix all (apply recommended patches)",
        },
        { value: FixPromptAction.CHOOSE, label: "[2] Choose which to fix" },
        { value: FixPromptAction.SKIP, label: "[3] Skip \u2014 proceed as-is" },
      ],
    });

    if (clack.isCancel(choice) || choice === FixPromptAction.SKIP) return null;

    const isAlreadySatisfied = (f: BPFinding): boolean => {
      if (!f.desiredStatePatch) return false;
      const fieldPath = extractPatchFieldPath(f.desiredStatePatch);
      if (!fieldPath) return false;
      const currentValue = getNestedValue(desiredState, fieldPath);
      const patchValue = extractPatchLeaf(f.desiredStatePatch);
      return currentValue === patchValue;
    };

    const applyPatch = (f: BPFinding): void => {
      const patch = f.desiredStatePatch!;
      const fieldPath = extractPatchFieldPath(patch);
      const oldValue = getNestedValue(desiredState, fieldPath);
      const merged = deepMergePatch(desiredState, patch);
      Object.keys(desiredState).forEach((k) => delete desiredState[k]);
      Object.assign(desiredState, merged);
      newAppliedFixes.push({
        practiceId: f.practiceId,
        title: f.title,
        fieldPath: fieldPath || f.propertyPath || UNKNOWN_FALLBACK,
        oldValue,
        newValue: extractPatchLeaf(patch),
      });
      fixedIds.add(f.practiceId);

      for (const other of fixableFindings) {
        if (fixedIds.has(other.practiceId)) continue;
        if (isAlreadySatisfied(other)) {
          fixedIds.add(other.practiceId);
        }
      }
    };

    if (choice === FixPromptAction.ALL) {
      for (const f of fixableFindings) {
        if (fixedIds.has(f.practiceId)) continue;
        applyPatch(f);
      }
    } else {
      for (const f of fixableFindings) {
        if (fixedIds.has(f.practiceId)) continue;
        const action = resolveAction(f);
        const result = await clack.select({
          message: f.title,
          options: [
            { value: FixPromptAction.FIX, label: `[Y] Fix (${action.hint})` },
            { value: FixPromptAction.SKIP, label: "[N] Skip" },
          ],
        });

        if (clack.isCancel(result) || result === FixPromptAction.SKIP) continue;
        applyPatch(f);
      }
    }
  } catch {
    if (fixedIds.size === 0) return null;
  }

  if (fixedIds.size === 0) return null;

  const residualFindings = items.filter((f) => !fixedIds.has(f.practiceId));

  return {
    desiredState,
    bpFindings: residualFindings,
    appliedFixes: newAppliedFixes,
  };
}

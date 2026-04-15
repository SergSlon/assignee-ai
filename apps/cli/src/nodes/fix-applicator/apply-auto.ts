/**
 * Auto-fix applicator (non-interactive path).
 *
 * Walks the auto-fixable findings and applies their `desiredStatePatch`
 * into a cloned `patchedState`, respecting user-explicit wizard choices
 * (elicitedOptions) and de-duplicating overlapping BPs.
 *
 * Mid-wizard transparency: surfaces each auto-fix in TTY mode so users
 * see *why* their plan drifted from what they typed into the wizard.
 *
 * Wave-6c F3: extracted from fix-applicator.ts (SRP).
 */

import * as clack from "@clack/prompts";
import type { BPFinding } from "@assignee/best-practices";
import type { AppliedFix } from "../../services/graph-state.js";
import { formatFixValue } from "../../utils/display-plan.js";
import {
  deepMergePatch,
  extractFieldPath,
  extractNewValue,
  extractOldValue,
  isFieldExplicitlySet,
  isPatchAlreadyApplied,
} from "./patch-utils.js";

export interface ApplyAutoResult {
  patchedState: Record<string, unknown>;
  appliedFixes: AppliedFix[];
  fixedPracticeIds: Set<string>;
  userChoicePracticeIds: Set<string>;
}

export function applyAutoFixes(params: {
  autoFixable: BPFinding[];
  originalState: Record<string, unknown>;
  elicitedOptions: Record<string, unknown> | undefined;
}): ApplyAutoResult {
  const { autoFixable, originalState, elicitedOptions } = params;

  const appliedFixes: AppliedFix[] = [];
  let patchedState = { ...originalState };
  const fixedPracticeIds = new Set<string>();
  const userChoicePracticeIds = new Set<string>();

  for (const finding of autoFixable) {
    if (fixedPracticeIds.has(finding.practiceId)) continue;
    const patch = finding.desiredStatePatch!;

    // Story 22.5: Skip if user explicitly set this field in the wizard
    if (isFieldExplicitlySet(elicitedOptions, patch)) {
      userChoicePracticeIds.add(finding.practiceId);
      continue;
    }

    if (isPatchAlreadyApplied(patchedState, patch)) {
      fixedPracticeIds.add(finding.practiceId);
      continue;
    }

    const oldValue = extractOldValue(originalState, patch);
    patchedState = deepMergePatch(patchedState, patch);

    const appliedFix: AppliedFix = {
      practiceId: finding.practiceId,
      title: finding.title,
      fieldPath: extractFieldPath(patch),
      oldValue,
      newValue: extractNewValue(patch),
    };
    appliedFixes.push(appliedFix);

    if (process.stdout.isTTY) {
      const old = formatFixValue(appliedFix.oldValue);
      const next = formatFixValue(appliedFix.newValue);
      clack.log.info(
        `Changed ${appliedFix.fieldPath}: ${old} → ${next} because ${appliedFix.practiceId} (auto-fixed)`,
      );
    }

    fixedPracticeIds.add(finding.practiceId);
  }

  return {
    patchedState,
    appliedFixes,
    fixedPracticeIds,
    userChoicePracticeIds,
  };
}

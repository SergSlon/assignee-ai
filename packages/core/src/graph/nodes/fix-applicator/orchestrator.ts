/**
 * fix_applicator orchestrator.
 *
 * Thin pipeline: resolve autofix mode → apply auto fixes → run interactive
 * prompts → emit residual findings. Each step is an SRP module in this folder.
 *
 * Preserves 3-mode auto_fix (feedback_autofix_user_decides) and the output
 * JSON shape {desiredState, bpFindings, appliedFixes, autoFixEnabled} that
 * downstream consumers rely on.
 *
 * Wave-6c F3: extracted from fix-applicator.ts (SRP).
 */

import { AutoFixMode } from "../../../index.js";
import type { BPFinding } from "@assignee/best-practices";
import type { AgentState } from "../../graph-state.js";
import type { AppliedFix } from "../../graph-state.js";
import { FixType } from "@assignee/best-practices";
import { log, LOG_ACTIONS } from "../../../utils/logger/index.js";
import { resolveAutoFixMode } from "./mode-resolver.js";
import { applyAutoFixes } from "./apply-auto.js";
import { runInteractiveFixes } from "./interactive-prompt.js";

export async function fixApplicatorNode(
  state: AgentState,
): Promise<Partial<AgentState>> {
  const findings = state.bpFindings ?? [];
  const desiredState = (state.desiredState as Record<string, unknown>) ?? {};

  if (findings.length === 0) {
    return {};
  }

  const autoFixMode = resolveAutoFixMode(state);
  const autoFixEnabled = autoFixMode === AutoFixMode.APPLY;

  const autoFixable = autoFixEnabled
    ? findings.filter((f) => f.autoFixable && f.desiredStatePatch)
    : [];

  const hasInteractive = findings.some(
    (f) =>
      f.fixType === FixType.INTERACTIVE &&
      f.interactiveOptions &&
      f.interactiveOptions.length > 0,
  );

  if (autoFixable.length === 0 && !hasInteractive) {
    return { appliedFixes: [], autoFixEnabled };
  }

  const originalState = { ...desiredState };
  const autoResult = applyAutoFixes({
    autoFixable,
    originalState,
    elicitedOptions: state.elicitedOptions,
  });

  const interactiveResult = await runInteractiveFixes({
    findings,
    patchedState: autoResult.patchedState,
    appliedFixes: autoResult.appliedFixes,
    fixedPracticeIds: autoResult.fixedPracticeIds,
    state,
  });

  const residualFindings: BPFinding[] = findings
    .filter((f) => !interactiveResult.fixedPracticeIds.has(f.practiceId))
    .map((f) => ({
      ...f,
      ...(autoResult.userChoicePracticeIds.has(f.practiceId)
        ? { userExplicitChoice: true }
        : {}),
      ...(interactiveResult.skippedPracticeIds.has(f.practiceId)
        ? { userSkipped: true }
        : {}),
    }));

  const appliedFixes: AppliedFix[] = interactiveResult.appliedFixes;

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
    desiredState: interactiveResult.patchedState,
    bpFindings: residualFindings,
    appliedFixes,
    autoFixEnabled: true,
  };
}

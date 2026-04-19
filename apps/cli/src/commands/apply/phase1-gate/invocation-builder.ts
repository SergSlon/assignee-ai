/**
 * Builder for the re-invocation argument object passed to
 * `graph.invoke(...)` after interactive BP fixes resolved all blocking
 * findings (Story 43.2 fix-and-continue path).
 *
 * Extracted from `phase1-gate.ts` in Story 58-it1-02 so the 6
 * conditional spreads can be unit-tested in isolation.
 */

import { ExecutionMode, BPEnforcementLevel } from "@assignee/core";
import type { AgentState } from "../../../services/graph.js";
import type { Phase1Context, Phase1Deps } from "../phase1-planner.js";

/**
 * Build the argument object passed to `graph.invoke(...)` when resuming
 * Phase 1 after interactive BP fixes succeeded.
 *
 * Conditional branches:
 *  1. `deps.opts.yes`           → `autoApprove: true`
 *  2. `deps.userConfig`         → `userConfig`
 *  3. `deps.orgConfig`          → `orgConfig`
 *  4. `deps.resolvedSourceDir`  → `sourceDir` + `sourceFileCount`
 *  5. `deps.userConfig?.bestPractices?.enforcement` → uses it else ENFORCE
 *  6. `residualFindings`        → forwarded as `bpFindings`
 */
export function buildContinueInvocation(
  ctx: Phase1Context,
  deps: Phase1Deps,
  phase1State: AgentState,
  residualFindings: AgentState["bpFindings"],
  effectiveIntent: string,
): Record<string, unknown> {
  return {
    checkpointResumed: true,
    userIntent: effectiveIntent,
    runId: ctx.runId,
    executionMode: ExecutionMode.APPLY,
    startedAt: Date.now(),
    projectDir: process.cwd(),
    resourceType: phase1State.resourceType,
    desiredState: phase1State.desiredState,
    estimatedMonthlyCost: phase1State.estimatedMonthlyCost,
    preflightPassed: true,
    bpFindings: residualFindings,
    appliedFixes: phase1State.appliedFixes,
    elicitedOptions: phase1State.elicitedOptions,
    resourceQueue: phase1State.resourceQueue,
    resourcePattern: phase1State.resourcePattern,
    bpEnforcementLevel:
      deps.userConfig?.bestPractices?.enforcement ?? BPEnforcementLevel.ENFORCE,
    ...(deps.opts.yes ? { autoApprove: true } : {}),
    ...(deps.userConfig ? { userConfig: deps.userConfig } : {}),
    ...(deps.orgConfig ? { orgConfig: deps.orgConfig } : {}),
    ...(deps.resolvedSourceDir
      ? {
          sourceDir: deps.resolvedSourceDir,
          sourceFileCount: deps.sourceFileCount,
        }
      : {}),
  };
}

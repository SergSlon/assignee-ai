/**
 * Re-evaluates BP rules against a desiredState outside the graph pipeline.
 * Used for checkpoint resume and MCP apply_plan to catch changed BP rules
 * that were added/modified after the original plan was generated.
 *
 * @see Story 41.3, Story 41.4
 */

import {
  loadBestPractices,
  evaluateTriggers,
  type BestPractice,
  type BPFinding,
  type EvalContext,
} from "@assignee/best-practices";

/** Module-level cache — mirrors bp-evaluator.ts caching strategy. */
let cachedPractices: BestPractice[] | undefined;

function loadCached(): BestPractice[] {
  if (cachedPractices === undefined) {
    cachedPractices = loadBestPractices();
  }
  return cachedPractices;
}

/** Resets the cached practices. Intended for testing only. */
export function resetBPReEvalCache(): void {
  cachedPractices = undefined;
}

export interface BPReEvalInput {
  resourceType: string;
  desiredState: Record<string, unknown>;
  userIntent?: string;
  patternId?: string;
}

export interface BPReEvalResult {
  findings: BPFinding[];
  blockingFindings: BPFinding[];
  hasBlocking: boolean;
}

/**
 * Re-evaluate BP rules against a checkpoint's desiredState.
 * Pure evaluation — no graph state mutation, no side effects beyond caching.
 */
export function reEvaluateBP(input: BPReEvalInput): BPReEvalResult {
  const practices = loadCached();

  const context: EvalContext = {
    resourceType: input.resourceType,
    desiredState: input.desiredState,
    userIntent: input.userIntent,
    patternId: input.patternId,
  };

  const findings = evaluateTriggers(context, practices);
  const blockingFindings = findings.filter((f) => f.blocking);

  return {
    findings,
    blockingFindings,
    hasBlocking: blockingFindings.length > 0,
  };
}

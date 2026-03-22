/**
 * bp_evaluator node — evaluates best practice rules against the planned
 * resource configuration and stores findings in graph state.
 *
 * Positioned between plan_generator and preflight_guard so CRITICAL
 * findings can block provisioning via preflight_guard.
 *
 * @see Story 12.3, ADR-009
 */

import {
  loadBestPractices,
  evaluateTriggers,
  type BestPractice,
  type BPFinding,
  type EvalContext,
} from "@assignee/best-practices";
import { log, LOG_ACTIONS } from "../utils/logger.js";
import type { AgentState } from "../services/graph.js";

/** Module-level cache to avoid reloading YAML files on every invocation. */
let cachedPractices: BestPractice[] | undefined;

/**
 * Loads best practices from YAML files, caching the result for the
 * lifetime of the process.
 *
 * @returns Array of validated BestPractice entries
 */
function loadCached(): BestPractice[] {
  if (cachedPractices === undefined) {
    cachedPractices = loadBestPractices();
  }
  return cachedPractices;
}

/**
 * Resets the cached practices. Intended for testing only.
 */
export function resetBPCache(): void {
  cachedPractices = undefined;
}

/**
 * bp_evaluator graph node.
 *
 * Evaluates all loaded best practices against the current resource's
 * desiredState. For compound resources, evaluates the current resource
 * being planned (identified by resourceType + desiredState).
 *
 * @param state - Current graph state after plan_generator
 * @returns Partial state update with bpFindings
 */
export async function bpEvaluatorNode(
  state: AgentState,
): Promise<Partial<AgentState>> {
  const practices = loadCached();

  const context: EvalContext = {
    resourceType: state.resourceType ?? "",
    desiredState: (state.desiredState as Record<string, unknown>) ?? {},
    userIntent: state.userIntent,
    patternId: state.resourcePattern?.patternId,
  };

  const findings: BPFinding[] = evaluateTriggers(context, practices);

  if (findings.length > 0) {
    log({
      ts: new Date().toISOString(),
      runId: state.runId,
      level: "info",
      action: LOG_ACTIONS.BP_EVALUATED,
      extras: {
        resourceType: state.resourceType,
        findingsCount: findings.length,
        criticals: findings.filter((f) => f.severity === "CRITICAL").length,
        highs: findings.filter((f) => f.severity === "HIGH").length,
      },
    });
  }

  return { bpFindings: findings };
}

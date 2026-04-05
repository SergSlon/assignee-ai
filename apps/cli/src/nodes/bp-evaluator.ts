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
  Severity,
  type BestPractice,
  type BPFinding,
  type EvalContext,
} from "@assignee/best-practices";
import type { StructuredTool } from "@langchain/core/tools";
import { log, LOG_ACTIONS } from "../utils/logger.js";
import type { AgentState } from "../services/graph.js";
import { enrichBpWithMcp } from "./advice/bp-mcp-enricher.js";

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
  tools?: StructuredTool[],
): Promise<Partial<AgentState>> {
  const practices = loadCached();

  const context: EvalContext = {
    resourceType: state.resourceType ?? "",
    desiredState: (state.desiredState as Record<string, unknown>) ?? {},
    userIntent: state.userIntent,
    patternId: state.resourcePattern?.patternId,
  };

  const findings: BPFinding[] = [];

  // Phase 1: MCP live best practices (primary source — current AWS data)
  let mcpAvailable = false;
  if (tools && tools.length > 0) {
    try {
      const mcpFindings = await enrichBpWithMcp(
        state.resourceType ?? "",
        (state.desiredState as Record<string, unknown>) ?? {},
        [], // no static findings yet — MCP is primary
        tools,
      );
      if (mcpFindings.length > 0) {
        findings.push(...mcpFindings);
        mcpAvailable = true;
      }
    } catch {
      // MCP unavailable — fall through to static rules
    }
  }

  // Phase 2: Static YAML rules — serve as:
  //   (a) Fallback when MCP is unavailable or returns nothing
  //   (b) Company policy enforcement (org-locked rules always apply)
  const staticFindings = evaluateTriggers(context, practices);
  for (const sf of staticFindings) {
    // Always add static findings that MCP didn't already cover.
    // Match on propertyPath when both have one; fall back to ruleId match.
    const alreadyCovered = findings.some(
      (f) =>
        (f.propertyPath &&
          sf.propertyPath &&
          f.propertyPath === sf.propertyPath) ||
        (f.practiceId && sf.practiceId && f.practiceId === sf.practiceId),
    );
    if (!alreadyCovered) {
      findings.push(sf);
    }
  }

  if (findings.length > 0) {
    log({
      ts: new Date().toISOString(),
      runId: state.runId,
      level: "info",
      action: LOG_ACTIONS.BP_EVALUATED,
      extras: {
        resourceType: state.resourceType,
        findingsCount: findings.length,
        criticals: findings.filter((f) => f.severity === Severity.CRITICAL)
          .length,
        highs: findings.filter((f) => f.severity === Severity.HIGH).length,
      },
    });
  }

  return { bpFindings: findings };
}

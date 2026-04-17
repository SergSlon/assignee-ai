/**
 * bp_evaluator orchestrator.
 *
 * Pipeline:
 *   1. Load + integrity-verify BP rules (rule-loader)
 *   2. MCP live enrichment (primary, current AWS data)
 *   3. Static YAML rules (fallback + org-locked policy enforcement)
 *   4. Compound-pattern suppression
 *   5. Emit aggregated findings
 *
 * Preserves output shape { bpFindings } and BP non-mutation invariant
 * (wizard-matrix-bp-hints memo).
 *
 * Wave-6c F3: extracted from bp-evaluator.ts (SRP).
 */

import {
  evaluateTriggers,
  Severity,
  type BPFinding,
  type EvalContext,
} from "@assignee/best-practices";
import type { StructuredTool } from "@langchain/core/tools";
import { log, LOG_ACTIONS } from "../../utils/logger.js";
import type { AgentState } from "../../services/graph.js";
import { enrichBpWithMcp } from "../advice/bp-mcp-enricher/orchestrator.js";
import { loadCached } from "./rule-loader.js";
import { suppressCompoundFindings } from "./compound-suppressor.js";

/**
 * bp_evaluator graph node.
 *
 * Evaluates all loaded best practices against the current resource's
 * desiredState. For compound resources, evaluates the current resource
 * being planned (identified by resourceType + desiredState).
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
  if (tools && tools.length > 0) {
    try {
      const mcpFindings = await enrichBpWithMcp(
        state.resourceType ?? "",
        (state.desiredState as Record<string, unknown>) ?? {},
        [],
        tools,
      );
      if (mcpFindings.length > 0) {
        findings.push(...mcpFindings);
      }
    } catch (err) {
      log({
        ts: new Date().toISOString(),
        runId: state.runId,
        level: "warn",
        action: LOG_ACTIONS.MCP_OPTIONAL_INIT_FAILED,
        extras: {
          phase: "bp_mcp_enricher",
          resourceType: state.resourceType,
          error: String(err),
        },
      });
    }
  }

  // Phase 2: Static YAML rules — fallback + company policy enforcement
  const staticFindings = evaluateTriggers(context, practices);
  for (const sf of staticFindings) {
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

  // Phase 3: Compound-pattern suppression
  const { findings: filteredFindings, suppressedCount } =
    suppressCompoundFindings(findings, state.resourcePattern?.patternId);

  if (filteredFindings.length > 0 || suppressedCount > 0) {
    log({
      ts: new Date().toISOString(),
      runId: state.runId,
      level: "info",
      action: LOG_ACTIONS.BP_EVALUATED,
      extras: {
        resourceType: state.resourceType,
        findingsCount: filteredFindings.length,
        criticals: filteredFindings.filter(
          (f) => f.severity === Severity.CRITICAL,
        ).length,
        highs: filteredFindings.filter((f) => f.severity === Severity.HIGH)
          .length,
        ...(suppressedCount > 0
          ? {
              compoundSuppressed: suppressedCount,
              patternId: state.resourcePattern?.patternId,
            }
          : {}),
      },
    });
  }

  return { bpFindings: filteredFindings };
}

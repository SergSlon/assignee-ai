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
  computeFreshness,
  computeManifest,
  verifyManifest,
  type BestPractice,
  type BPFinding,
  type EvalContext,
} from "@assignee/best-practices";
import type { StructuredTool } from "@langchain/core/tools";
import * as path from "node:path";
import { log, LOG_ACTIONS } from "../utils/logger.js";
import type { AgentState } from "../services/graph.js";
import { enrichBpWithMcp } from "./advice/bp-mcp-enricher.js";

/** Module-level cache to avoid reloading YAML files on every invocation. */
let cachedPractices: BestPractice[] | undefined;
/** Track whether freshness/integrity warnings were already emitted this process. */
let integrityWarningEmitted = false;

/**
 * Loads best practices from YAML files, caching the result for the
 * lifetime of the process. Also runs freshness + integrity checks on first
 * load and emits warnings to stderr (once per process).
 *
 * @returns Array of validated BestPractice entries
 */
function loadCached(): BestPractice[] {
  if (cachedPractices === undefined) {
    cachedPractices = loadBestPractices();

    // Run freshness + integrity checks on first load (Stories 12.4 + 12.6).
    // Warnings only — never block. Failures are non-fatal.
    if (!integrityWarningEmitted) {
      integrityWarningEmitted = true;
      try {
        // Freshness — warn if oldest BP YAML is > 180 days old
        const freshness = computeFreshness();
        if (freshness.isStale && process.stderr.isTTY) {
          process.stderr.write(
            `\u001B[33m⚠  Best-practice rules are stale (oldest file is ${freshness.oldestAgeDays} days old, threshold is ${freshness.staleThresholdDays}). ` +
              `Consider updating assignee-ai.\u001B[0m\n`,
          );
        }

        // Integrity — verify against manifest if present
        const computed = computeManifest();
        // Manifest lives at packages/best-practices/manifest.json relative to the loaded dir
        // computeFreshness/computeManifest use the same baseDir logic
        const manifestPath = path.join(
          import.meta.dirname ?? process.cwd(),
          "..",
          "..",
          "packages",
          "best-practices",
          "manifest.json",
        );
        const verification = verifyManifest(computed, manifestPath);
        if (!verification.valid && process.stderr.isTTY) {
          process.stderr.write(
            `\u001B[31m⚠  BP manifest integrity check failed: ${verification.reason}\u001B[0m\n`,
          );
          if (
            verification.mismatchedFiles &&
            verification.mismatchedFiles.length > 0
          ) {
            process.stderr.write(
              `   Mismatched files: ${verification.mismatchedFiles.slice(0, 5).join(", ")}${verification.mismatchedFiles.length > 5 ? "…" : ""}\n`,
            );
          }
        }
      } catch {
        // Integrity checks are best-effort — never break loading
      }
    }
  }
  return cachedPractices;
}

/**
 * Resets the cached practices. Intended for testing only.
 */
export function resetBPCache(): void {
  cachedPractices = undefined;
  integrityWarningEmitted = false;
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

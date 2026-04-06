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
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
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
        // Freshness — warn if oldest BP YAML is > 180 days old.
        // Warning is emitted to stderr unconditionally (no TTY gate) so
        // piped output and CI still see staleness warnings.
        const freshness = computeFreshness();
        if (freshness.isStale) {
          process.stderr.write(
            `⚠  Best-practice rules are stale (oldest file is ${freshness.oldestAgeDays} days old, threshold is ${freshness.staleThresholdDays}). ` +
              `Consider updating assignee-ai.\n`,
          );
        }

        // Integrity — verify against manifest if present.
        // Manifest path resolution: try multiple candidates so it works for
        //   (a) monorepo dev: apps/cli/src/nodes/bp-evaluator.ts → ../../../../packages/best-practices/
        //   (b) npm-installed CLI: node_modules/@assignee/cli/dist/nodes → ../../@assignee/best-practices/
        //   (c) published tarball: next to cli via createRequire resolution
        const computed = computeManifest();
        const manifestPath = resolveBpManifestPath();
        const verification = verifyManifest(computed, manifestPath);
        if (!verification.valid) {
          // Integrity failures are emitted unconditionally to stderr (no TTY gate).
          // CI and piped output must see integrity warnings or the feature is theater.
          process.stderr.write(
            `⚠  BP manifest integrity check failed: ${verification.reason}\n`,
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
 * Resolve the BP manifest path across install layouts.
 * Returns the first path that exists, or the first candidate if none do
 * (which causes `verifyManifest` to enter trust-on-first-use mode).
 */
function resolveBpManifestPath(): string {
  const dirname = import.meta.dirname ?? process.cwd();

  const candidates: string[] = [
    // Monorepo dev (apps/cli/src/nodes/)
    path.join(
      dirname,
      "..",
      "..",
      "..",
      "..",
      "packages",
      "best-practices",
      "manifest.json",
    ),
    // Monorepo dist (apps/cli/dist/nodes/)
    path.join(
      dirname,
      "..",
      "..",
      "..",
      "packages",
      "best-practices",
      "manifest.json",
    ),
    // Installed layout: resolve via package name
    path.join(
      dirname,
      "..",
      "..",
      "..",
      "@assignee",
      "best-practices",
      "manifest.json",
    ),
  ];

  // Prefer createRequire.resolve for installed layouts — most reliable
  try {
    const req = createRequire(import.meta.url);
    const resolved = req.resolve("@assignee/best-practices/manifest.json");
    candidates.unshift(resolved);
  } catch {
    // createRequire.resolve may fail if manifest.json isn't in the package exports
  }

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // continue
    }
  }
  // Return the first candidate so verifyManifest returns trust-on-first-use
  return candidates[0]!;
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

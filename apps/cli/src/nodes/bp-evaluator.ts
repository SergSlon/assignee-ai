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
import { EnvVar } from "../constants/env-vars.js";
import type { AgentState } from "../services/graph.js";
import { enrichBpWithMcp } from "./advice/bp-mcp-enricher.js";

/** BP integrity enforcement mode for the current process. */
export const BpIntegrityMode = {
  ENFORCE: "enforce",
  WARN: "warn",
  DISABLED: "disabled",
} as const;

export type BpIntegrityModeType =
  (typeof BpIntegrityMode)[keyof typeof BpIntegrityMode];

/**
 * Thrown when BP integrity verification fails in enforce mode. Preflight
 * should catch this at the top of the pipeline and block the plan.
 */
export class BpIntegrityError extends Error {
  constructor(
    message: string,
    public readonly reason: string,
    public readonly mismatchedFiles: string[] = [],
  ) {
    super(message);
    this.name = "BpIntegrityError";
  }
}

/**
 * Resolve the integrity enforcement mode from env var + NODE_ENV.
 *   - ASSIGNEE_BP_INTEGRITY=enforce|warn|disabled → explicit override
 *   - NODE_ENV=test → "warn" default (so tests don't fail on TOFU)
 *   - otherwise → "enforce" default (production-safe)
 */
export function resolveBpIntegrityMode(): BpIntegrityModeType {
  const raw = (process.env[EnvVar.ASSIGNEE_BP_INTEGRITY] ?? "").toLowerCase();
  if (raw === BpIntegrityMode.ENFORCE) return BpIntegrityMode.ENFORCE;
  if (raw === BpIntegrityMode.WARN) return BpIntegrityMode.WARN;
  if (raw === BpIntegrityMode.DISABLED) return BpIntegrityMode.DISABLED;
  if (process.env["NODE_ENV"] === "test") return BpIntegrityMode.WARN;
  return BpIntegrityMode.ENFORCE;
}

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

    // Run freshness + integrity checks on first load (Stories 12.4 + 12.6, H18).
    if (!integrityWarningEmitted) {
      integrityWarningEmitted = true;
      const mode = resolveBpIntegrityMode();

      // Freshness — warn if oldest BP YAML is > 180 days old.
      // Always evaluated, regardless of integrity mode. Best-effort.
      try {
        const freshness = computeFreshness();
        if (freshness.isStale) {
          process.stderr.write(
            `⚠  Best-practice rules are stale (oldest file is ${freshness.oldestAgeDays} days old, threshold is ${freshness.staleThresholdDays}). ` +
              `Consider updating assignee-ai.\n`,
          );
        }
      } catch (err) {
        log({
          ts: new Date().toISOString(),
          runId: "system",
          level: "warn",
          action: LOG_ACTIONS.BP_EVALUATED,
          extras: { phase: "freshness_check", error: String(err) },
        });
      }

      if (mode === BpIntegrityMode.DISABLED) {
        return cachedPractices;
      }

      // Integrity — verify against manifest.
      // In enforce mode a missing manifest is a failure (strictNoReference).
      // In warn mode TOFU still emits a loud warning but does not block.
      try {
        const computed = computeManifest();
        const manifestPath = resolveBpManifestPath();
        const verification = verifyManifest(computed, manifestPath, {
          strictNoReference: mode === BpIntegrityMode.ENFORCE,
        });

        if (verification.trustOnFirstUse && mode === BpIntegrityMode.WARN) {
          // Always warn loudly on TOFU, even outside enforce mode.
          process.stderr.write(
            `⚠  BP manifest trust-on-first-use: no reference manifest at ${manifestPath}. ` +
              `Running with unverified best-practices. Set ASSIGNEE_BP_INTEGRITY=enforce to block.\n`,
          );
        }

        if (!verification.valid) {
          const detail =
            verification.mismatchedFiles &&
            verification.mismatchedFiles.length > 0
              ? ` Mismatched files: ${verification.mismatchedFiles.slice(0, 5).join(", ")}${verification.mismatchedFiles.length > 5 ? "…" : ""}`
              : "";
          const message = `BP manifest integrity check failed: ${verification.reason}${detail}`;

          if (mode === BpIntegrityMode.ENFORCE) {
            log({
              ts: new Date().toISOString(),
              runId: "system",
              level: "error",
              action: LOG_ACTIONS.BP_EVALUATED,
              extras: {
                phase: "integrity_check",
                mode,
                reason: verification.reason,
                mismatchedFiles: verification.mismatchedFiles,
              },
            });
            throw new BpIntegrityError(
              message,
              verification.reason ?? "unknown",
              verification.mismatchedFiles ?? [],
            );
          }

          // Warn mode — print to stderr, do not block.
          process.stderr.write(`⚠  ${message}\n`);
          log({
            ts: new Date().toISOString(),
            runId: "system",
            level: "warn",
            action: LOG_ACTIONS.BP_EVALUATED,
            extras: {
              phase: "integrity_check",
              mode,
              reason: verification.reason,
            },
          });
        }
      } catch (err) {
        if (err instanceof BpIntegrityError) throw err;
        // Unexpected failure during verification (e.g. fs error reading
        // manifest). In enforce mode this is still a blocking condition.
        if (mode === BpIntegrityMode.ENFORCE) {
          throw new BpIntegrityError(
            `BP integrity check failed unexpectedly: ${String(err)}`,
            String(err),
          );
        }
        log({
          ts: new Date().toISOString(),
          runId: "system",
          level: "warn",
          action: LOG_ACTIONS.BP_EVALUATED,
          extras: { phase: "integrity_check", error: String(err) },
        });
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
  } catch (err) {
    // createRequire.resolve may fail if manifest.json isn't in the package exports
    log({
      ts: new Date().toISOString(),
      runId: "system",
      level: "info",
      action: LOG_ACTIONS.BP_EVALUATED,
      extras: {
        phase: "manifest_resolve_via_require",
        error: String(err),
      },
    });
  }

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (err) {
      // continue — fs.existsSync threw on this candidate path
      log({
        ts: new Date().toISOString(),
        runId: "system",
        level: "info",
        action: LOG_ACTIONS.BP_EVALUATED,
        extras: {
          phase: "manifest_candidate_stat",
          candidate,
          error: String(err),
        },
      });
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
    } catch (err) {
      // MCP unavailable — fall through to static rules
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

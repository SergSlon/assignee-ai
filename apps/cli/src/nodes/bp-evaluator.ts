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
 * REG-N3: separate flag tracking whether the integrity check has actually
 * succeeded. This MUST be reset to `false` on every thrown
 * BpIntegrityError, otherwise a tampered manifest would only block the
 * first call in a process and silently allow every subsequent invocation
 * to use the unverified rules.
 */
let integrityChecked = false;

/**
 * Loads best practices from YAML files, caching the result for the
 * lifetime of the process. Also runs freshness + integrity checks on first
 * load and emits warnings to stderr (once per process).
 *
 * REG-N3: practices are only cached AFTER the integrity check passes.
 * If the integrity check throws, the cache stays empty so the next call
 * re-runs the check (and re-throws), instead of returning unverified
 * rules from a populated cache.
 *
 * @returns Array of validated BestPractice entries
 */
function loadCached(): BestPractice[] {
  // Fast path: cache only used once integrity check has actually succeeded.
  if (cachedPractices !== undefined && integrityChecked) {
    return cachedPractices;
  }

  // Load fresh rules into a local — do NOT populate the module cache until
  // the integrity check passes. (REG-N3: a previous version assigned to
  // cachedPractices BEFORE the check, so a tampered manifest only blocked
  // the first call and silently allowed every subsequent call to use the
  // cached, unverified rules.)
  const loaded = loadBestPractices();
  const mode = resolveBpIntegrityMode();

  // Freshness — warn if oldest BP YAML is > 180 days old. Best-effort,
  // emitted at most once per process.
  if (!integrityWarningEmitted) {
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
        action: LOG_ACTIONS.BP_EVALUATION_SKIPPED,
        extras: { phase: "freshness_check", error: String(err) },
      });
    }
  }

  if (mode === BpIntegrityMode.DISABLED) {
    cachedPractices = loaded;
    integrityChecked = true;
    integrityWarningEmitted = true;
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

    if (
      verification.trustOnFirstUse &&
      mode === BpIntegrityMode.WARN &&
      !integrityWarningEmitted
    ) {
      // Always warn loudly on TOFU, even outside enforce mode.
      process.stderr.write(
        `⚠  BP manifest trust-on-first-use: no reference manifest at ${manifestPath}. ` +
          `Running with unverified best-practices. Set ASSIGNEE_BP_INTEGRITY=enforce to block.\n`,
      );
    }

    // ── GPG signature enforcement (additive to hash check) ──────────────
    // `verification.signature` is populated whenever a reference manifest
    // exists. It has four relevant states:
    //   - verified: true  → signature matches, key captured
    //   - verified: false, signaturePresent: false → unsigned (TOFU path)
    //   - verified: false, signaturePresent: true, reason: "gpg not available"
    //   - verified: false, signaturePresent: true, reason: "signature invalid"
    //
    // Policy in ENFORCE mode:
    //   1. If signature exists but is invalid → HARD FAIL (throw). An
    //      attacker who tampers with the YAML and regenerates the hash
    //      cannot also forge the signature.
    //   2. If signature is missing and ASSIGNEE_BP_REQUIRE_SIGNATURE is
    //      set → HARD FAIL.
    //   3. If signature is missing and the env var is NOT set → WARN loudly
    //      but accept (preserves the unsigned-manifest install path).
    //   4. If GPG is not installed → WARN, treat like missing signature
    //      (accept unless ASSIGNEE_BP_REQUIRE_SIGNATURE is set).
    const sig = verification.signature;
    const requireSignature =
      (process.env[EnvVar.ASSIGNEE_BP_REQUIRE_SIGNATURE] ?? "").trim().length >
      0;
    if (sig && mode === BpIntegrityMode.ENFORCE) {
      if (sig.signaturePresent && sig.reason === "signature invalid") {
        // Hard fail regardless of ASSIGNEE_BP_REQUIRE_SIGNATURE — an
        // invalid signature is always worse than an absent one.
        cachedPractices = undefined;
        integrityChecked = false;
        const keyLabel = sig.signedByKey ?? "unknown key";
        throw new BpIntegrityError(
          `BP manifest signature is INVALID (key: ${keyLabel}). ` +
            `The manifest may have been tampered with after signing, or the ` +
            `signing key was rotated without re-signing. Refusing to load BP rules.`,
          "signature invalid",
        );
      }
      if (!sig.verified && !sig.signaturePresent && requireSignature) {
        cachedPractices = undefined;
        integrityChecked = false;
        throw new BpIntegrityError(
          `BP manifest is unsigned but ASSIGNEE_BP_REQUIRE_SIGNATURE is set. ` +
            `Refusing to load BP rules without a valid GPG signature.`,
          "signature required but missing",
        );
      }
      if (
        !sig.verified &&
        sig.signaturePresent &&
        sig.reason === "gpg not available" &&
        requireSignature
      ) {
        cachedPractices = undefined;
        integrityChecked = false;
        throw new BpIntegrityError(
          `BP manifest signature present but GPG is not installed, and ` +
            `ASSIGNEE_BP_REQUIRE_SIGNATURE is set. Install gpg or unset the ` +
            `env var to proceed.`,
          "gpg not available",
        );
      }
      if (
        !sig.verified &&
        !sig.signaturePresent &&
        !requireSignature &&
        !integrityWarningEmitted
      ) {
        process.stderr.write(
          `⚠  BP manifest is unsigned — accepting on trust. ` +
            `Set ASSIGNEE_BP_REQUIRE_SIGNATURE=1 to require a valid GPG signature.\n`,
        );
      }
      if (
        !sig.verified &&
        sig.signaturePresent &&
        sig.reason === "gpg not available" &&
        !integrityWarningEmitted
      ) {
        process.stderr.write(
          `⚠  BP manifest signature present but GPG is not installed — skipping signature check.\n`,
        );
      }
    }

    if (!verification.valid) {
      const detail =
        verification.mismatchedFiles && verification.mismatchedFiles.length > 0
          ? ` Mismatched files: ${verification.mismatchedFiles.slice(0, 5).join(", ")}${verification.mismatchedFiles.length > 5 ? "…" : ""}`
          : "";
      const message = `BP manifest integrity check failed: ${verification.reason}${detail}`;

      if (mode === BpIntegrityMode.ENFORCE) {
        log({
          ts: new Date().toISOString(),
          runId: "system",
          level: "error",
          action: LOG_ACTIONS.BP_EVALUATION_SKIPPED,
          extras: {
            phase: "integrity_check",
            mode,
            reason: verification.reason,
            mismatchedFiles: verification.mismatchedFiles,
          },
        });
        // REG-N3: ensure cache + integrityChecked are NOT populated on
        // throw, so the next call re-runs the check and re-throws.
        cachedPractices = undefined;
        integrityChecked = false;
        throw new BpIntegrityError(
          message,
          verification.reason ?? "unknown",
          verification.mismatchedFiles ?? [],
        );
      }

      // Warn mode — print to stderr at most once per process, log every time.
      if (!integrityWarningEmitted) {
        process.stderr.write(`⚠  ${message}\n`);
      }
      log({
        ts: new Date().toISOString(),
        runId: "system",
        level: "warn",
        action: LOG_ACTIONS.BP_EVALUATION_SKIPPED,
        extras: {
          phase: "integrity_check",
          mode,
          reason: verification.reason,
        },
      });
    }
  } catch (err) {
    if (err instanceof BpIntegrityError) {
      // Already cleared the cache + flag above; just propagate.
      throw err;
    }
    // Unexpected failure during verification (e.g. fs error reading
    // manifest). In enforce mode this is still a blocking condition and
    // must NOT poison the cache.
    if (mode === BpIntegrityMode.ENFORCE) {
      cachedPractices = undefined;
      integrityChecked = false;
      throw new BpIntegrityError(
        `BP integrity check failed unexpectedly: ${String(err)}`,
        String(err),
      );
    }
    log({
      ts: new Date().toISOString(),
      runId: "system",
      level: "warn",
      action: LOG_ACTIONS.BP_EVALUATION_SKIPPED,
      extras: { phase: "integrity_check", error: String(err) },
    });
  }

  // Integrity check completed (or warn-mode tolerated a failure) — safe
  // to cache the loaded rules now.
  cachedPractices = loaded;
  integrityChecked = true;
  integrityWarningEmitted = true;
  return cachedPractices;
}

/**
 * Build the list of normalized candidate paths for the BP manifest.
 * Exported so the L5 audit regression test can assert every entry collapses
 * through `path.normalize` and stays within a sane filesystem boundary.
 *
 * L5 V1 audit (2026-04-06): every candidate is normalized so `..` segments
 * collapse predictably across platforms. Currently the candidates are
 * static (no user input) but defense-in-depth is cheap.
 */
export function _listBpManifestCandidates(dirname: string): string[] {
  return [
    // Monorepo dev (apps/cli/src/nodes/)
    path.normalize(
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
    ),
    // Monorepo dist (apps/cli/dist/nodes/)
    path.normalize(
      path.join(
        dirname,
        "..",
        "..",
        "..",
        "packages",
        "best-practices",
        "manifest.json",
      ),
    ),
    // Installed layout: resolve via package name
    path.normalize(
      path.join(
        dirname,
        "..",
        "..",
        "..",
        "@assignee",
        "best-practices",
        "manifest.json",
      ),
    ),
  ];
}

/**
 * Resolve the BP manifest path across install layouts.
 * Returns the first path that exists, or the first candidate if none do
 * (which causes `verifyManifest` to enter trust-on-first-use mode).
 */
function resolveBpManifestPath(): string {
  const dirname = import.meta.dirname ?? process.cwd();
  const candidates: string[] = _listBpManifestCandidates(dirname);

  // Prefer createRequire.resolve for installed layouts — most reliable.
  // The resolved path is also normalized so the boundary invariant holds
  // for every entry the loop below will iterate over.
  try {
    const req = createRequire(import.meta.url);
    const resolved = path.normalize(
      req.resolve("@assignee/best-practices/manifest.json"),
    );
    candidates.unshift(resolved);
  } catch (err) {
    // createRequire.resolve may fail if manifest.json isn't in the package exports
    log({
      ts: new Date().toISOString(),
      runId: "system",
      level: "info",
      action: LOG_ACTIONS.BP_EVALUATION_SKIPPED,
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
        action: LOG_ACTIONS.BP_EVALUATION_SKIPPED,
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
  integrityChecked = false;
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

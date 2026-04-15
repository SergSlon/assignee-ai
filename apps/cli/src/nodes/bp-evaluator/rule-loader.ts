/**
 * BP rule loader with integrity + signature enforcement.
 *
 * Module-level cache is populated ONLY after the integrity check passes
 * (REG-N3). A tampered manifest must fail every call, not just the first.
 *
 * Invariant: BP count is 186 (as of 2026-04 docs). Loader returns all
 * validated BestPractice entries from YAML.
 *
 * Wave-6c F3: extracted from bp-evaluator.ts (SRP).
 */

import {
  loadBestPractices,
  computeFreshness,
  computeManifest,
  verifyManifest,
  type BestPractice,
} from "@assignee/best-practices";
import { log, LOG_ACTIONS } from "../../utils/logger.js";
import { EnvVar } from "../../constants/env-vars.js";
import {
  BpIntegrityError,
  BpIntegrityMode,
  resolveBpIntegrityMode,
} from "./integrity-mode.js";
import { resolveBpManifestPath } from "./manifest-path.js";

let cachedPractices: BestPractice[] | undefined;
let integrityWarningEmitted = false;
/**
 * REG-N3: separate flag tracking whether the integrity check has actually
 * succeeded. Reset to false on every thrown BpIntegrityError.
 */
let integrityChecked = false;

/** Loads and verifies BP rules, caching after integrity passes. */
export function loadCached(): BestPractice[] {
  if (cachedPractices !== undefined && integrityChecked) {
    return cachedPractices;
  }

  const loaded = loadBestPractices();
  const mode = resolveBpIntegrityMode();

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
      process.stderr.write(
        `⚠  BP manifest trust-on-first-use: no reference manifest at ${manifestPath}. ` +
          `Running with unverified best-practices. Set ASSIGNEE_BP_INTEGRITY=enforce to block.\n`,
      );
    }

    enforceSignature({
      verification,
      mode,
      integrityWarningEmitted,
    });

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
        cachedPractices = undefined;
        integrityChecked = false;
        throw new BpIntegrityError(
          message,
          verification.reason ?? "unknown",
          verification.mismatchedFiles ?? [],
        );
      }

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
      throw err;
    }
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

  cachedPractices = loaded;
  integrityChecked = true;
  integrityWarningEmitted = true;
  return cachedPractices;
}

/**
 * GPG signature enforcement (additive to hash check).
 *
 * ENFORCE mode policy:
 *   1. signature present + invalid      → HARD FAIL (throw)
 *   2. signature missing + REQUIRE set  → HARD FAIL
 *   3. gpg not available + REQUIRE set  → HARD FAIL
 *   4. signature missing (no REQUIRE)   → WARN + accept
 *   5. gpg not available (no REQUIRE)   → WARN + accept
 */
function enforceSignature(params: {
  verification: ReturnType<typeof verifyManifest>;
  mode: string;
  integrityWarningEmitted: boolean;
}): void {
  const { verification, mode } = params;
  const sig = verification.signature;
  const requireSignature =
    (process.env[EnvVar.ASSIGNEE_BP_REQUIRE_SIGNATURE] ?? "").trim().length > 0;
  if (!sig || mode !== BpIntegrityMode.ENFORCE) return;

  if (sig.signaturePresent && sig.reason === "signature invalid") {
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
    !params.integrityWarningEmitted
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
    !params.integrityWarningEmitted
  ) {
    process.stderr.write(
      `⚠  BP manifest signature present but GPG is not installed — skipping signature check.\n`,
    );
  }
}

/** Resets the cached practices. Intended for testing only. */
export function resetBPCache(): void {
  cachedPractices = undefined;
  integrityWarningEmitted = false;
  integrityChecked = false;
}

/**
 * Strict-mode manifest verifier — hashes a computed manifest against a
 * reference manifest on disk and attaches an additive GPG signature result.
 *
 * Split from integrity.ts (W6d F3). Decision policy lives here; the hash
 * math and the GPG call live in sibling modules.
 */

import { existsSync, readFileSync } from "node:fs";
import { verifyManifestSignature } from "./gpg-verify.js";
import type { ManifestSignatureResult } from "./signature-loader.js";
import type { BPManifest } from "./manifest-check.js";

/** Result of comparing a runtime manifest against a reference. */
export interface ManifestVerifyResult {
  valid: boolean;
  reason?: string;
  mismatchedFiles?: string[];
  /**
   * True when verification succeeded only because no reference was present
   * AND the caller did not request strict mode. Mutually exclusive with
   * `valid: false` — strict-mode failures use `referenceMissing` instead.
   */
  trustOnFirstUse?: boolean;
  /**
   * True when the reference manifest file did not exist on disk. Set
   * regardless of strict mode so callers can distinguish "no reference"
   * from "hash mismatch" / "corrupt reference".
   */
  referenceMissing?: boolean;
  /**
   * Additive GPG signature-verification result. Always populated (never
   * undefined) so callers can make enforcement decisions without having to
   * null-check. A missing `.sig` file yields `{ verified: false,
   * signedByKey: null, signaturePresent: false }` — NOT an error — which
   * preserves the pre-signing "trust the manifest on disk" behaviour.
   */
  signature?: ManifestSignatureResult;
}

/** Options controlling verifyManifest behaviour. */
export interface VerifyManifestOptions {
  /**
   * When true, a missing reference manifest is treated as an integrity
   * failure (valid: false) rather than trust-on-first-use. Used by
   * enforce-mode callers that require a signed manifest to exist.
   */
  strictNoReference?: boolean;
}

/**
 * Verify a computed manifest against a reference manifest file on disk.
 *
 * If the reference doesn't exist and `strictNoReference` is false (default),
 * the manifest is considered "trust on first use" — valid but unverified.
 * When `strictNoReference` is true, a missing reference is an integrity
 * failure: callers in enforce mode must reject the BP library rather than
 * trust it blindly.
 *
 * When a reference manifest IS present, an additional GPG signature
 * verification is performed against `${referencePath}.sig`. The result is
 * attached to `signature` on the returned object and is additive — a
 * missing or invalid signature does NOT make `valid: false` here. Callers
 * enforce signature presence via their own policy (see
 * bp-evaluator's ASSIGNEE_BP_REQUIRE_SIGNATURE env var).
 */
export function verifyManifest(
  computed: BPManifest,
  referencePath: string,
  options: VerifyManifestOptions = {},
): ManifestVerifyResult {
  if (!existsSync(referencePath)) {
    if (options.strictNoReference) {
      return {
        valid: false,
        reason: `No reference manifest found at ${referencePath}. Refusing to trust BP library in strict mode.`,
        // REG-N7: Strict-fail must NOT also signal trustOnFirstUse —
        // callers gate WARN-mode banners on trustOnFirstUse and would
        // otherwise show a contradictory "trusting on first use" message
        // alongside a hard failure. Use referenceMissing instead.
        trustOnFirstUse: false,
        referenceMissing: true,
      };
    }
    return {
      valid: true,
      reason: "No reference manifest (trust-on-first-use)",
      trustOnFirstUse: true,
      referenceMissing: true,
    };
  }

  // Verify the detached signature (if any). Result is additive: a missing
  // or invalid signature is reported on `signature` but does not by itself
  // invalidate the manifest — callers decide enforcement.
  const signature = verifyManifestSignature(referencePath);

  let reference: BPManifest;
  try {
    const raw = readFileSync(referencePath, "utf-8");
    reference = JSON.parse(raw) as BPManifest;
  } catch (err) {
    return {
      valid: false,
      reason: `Reference manifest is corrupt: ${err instanceof Error ? err.message : String(err)}`,
      signature,
    };
  }

  if (reference.version !== 1) {
    return {
      valid: false,
      reason: `Unsupported manifest version: ${reference.version}`,
      signature,
    };
  }

  if (reference.hash === computed.hash) {
    return { valid: true, signature };
  }

  // Hashes differ — find specific mismatched files for diagnostic output
  const mismatched: string[] = [];
  const allKeys = new Set([
    ...Object.keys(reference.files),
    ...Object.keys(computed.files),
  ]);
  for (const key of allKeys) {
    if (reference.files[key] !== computed.files[key]) {
      mismatched.push(key);
    }
  }

  return {
    valid: false,
    reason: `BP library hash mismatch (expected ${reference.hash.slice(0, 12)}…, got ${computed.hash.slice(0, 12)}…). ${mismatched.length} file(s) differ.`,
    mismatchedFiles: mismatched,
    signature,
  };
}

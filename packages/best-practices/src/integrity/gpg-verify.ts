/**
 * GPG signature verification for the BP manifest. Split from integrity.ts
 * (W6d F3). Policy: signing is OPT-IN. A missing .sig file is not an
 * error — it simply means the manifest shipped unsigned. GPG not being
 * installed is also not an error: we downgrade to `verified: false` with
 * a reason so callers can decide whether to tolerate it (warn mode) or
 * reject it (enforce mode via ASSIGNEE_BP_REQUIRE_SIGNATURE).
 */

import { existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import {
  extractKeyFromGpgStatus,
  type ManifestSignatureResult,
} from "./signature-loader.js";

/**
 * Verify a detached GPG signature for a manifest file.
 *
 * The verification uses `gpg --verify manifest.json.sig manifest.json`.
 * GPG exits 0 only when the signature is valid AND the signing key is
 * trusted by the current keyring. When GPG exits non-zero we return
 * `verified: false` with a reason string extracted from stderr.
 */
export function verifyManifestSignature(
  manifestPath: string,
): ManifestSignatureResult {
  const sigPath = `${manifestPath}.sig`;

  if (!existsSync(sigPath)) {
    return {
      verified: false,
      signedByKey: null,
      signaturePresent: false,
      reason: "signature file missing",
    };
  }

  // GPG is optional — if the binary is not on PATH we degrade gracefully.
  // Probe with `gpg --version`; any error (ENOENT, non-zero exit) means
  // we cannot verify signatures in this environment.
  try {
    execFileSync("gpg", ["--version"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    return {
      verified: false,
      signedByKey: null,
      signaturePresent: true,
      reason: "gpg not available",
    };
  }

  // Single gpg invocation that both verifies the signature AND emits the
  // machine-readable status lines we need to extract the signing key id.
  // Using `--status-fd=1` routes VALIDSIG/GOODSIG to stdout, leaving stderr
  // for the human-readable verify output. spawnSync never throws on non-zero
  // exit, so we can decide success purely from `result.status`.
  //
  // History: an earlier implementation called gpg twice (once for verify,
  // once for status capture), paying 2x fork/exec cost and opening a tiny
  // TOCTOU window between runs. One call closes both holes.
  const result = spawnSync(
    "gpg",
    ["--verify", "--status-fd=1", "--batch", sigPath, manifestPath],
    { stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" },
  );

  if (result.error) {
    // ENOENT etc. — the earlier --version probe should have caught this,
    // but surface it defensively rather than claiming "signature invalid".
    return {
      verified: false,
      signedByKey: null,
      signaturePresent: true,
      reason: "gpg not available",
    };
  }

  const statusOutput = String(result.stdout ?? "");
  const signedByKey = extractKeyFromGpgStatus(statusOutput);

  if (result.status !== 0) {
    return {
      verified: false,
      signedByKey,
      signaturePresent: true,
      reason: "signature invalid",
    };
  }

  return {
    verified: true,
    signedByKey,
    signaturePresent: true,
  };
}

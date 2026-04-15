/**
 * Signature verification result shape + helpers shared between the GPG
 * verifier and strict-mode enforcer.
 *
 * Split from integrity.ts (W6d F3).
 */

/** Signature verification result, additive to the hash check. */
export interface ManifestSignatureResult {
  /**
   * True only when a `.sig` file exists, GPG is installed, and the signature
   * verified successfully against the manifest. False in every other case
   * (missing sig, missing gpg binary, bad signature).
   */
  verified: boolean;
  /**
   * Key ID or fingerprint that signed the manifest, when GPG reported one.
   * Null when no signature was present or GPG could not extract a key id.
   */
  signedByKey: string | null;
  /**
   * Human-readable reason for a non-verified result. Populated for
   * "signature file missing", "gpg not available", and "signature invalid"
   * states. Unset when `verified: true`.
   */
  reason?: string;
  /**
   * True when the `.sig` file was present on disk regardless of whether
   * the verification ultimately succeeded. Callers in enforce mode use
   * this to distinguish "unsigned manifest (TOFU)" from "signed manifest
   * with invalid signature (hard fail)".
   */
  signaturePresent: boolean;
}

/**
 * Extract the signing key fingerprint or long key id from GPG --status-fd
 * output. Returns null when no VALIDSIG/GOODSIG line is present.
 */
export function extractKeyFromGpgStatus(status: string): string | null {
  const validSig = /\[GNUPG:\]\s+VALIDSIG\s+([A-F0-9]{16,40})/i.exec(status);
  if (validSig && validSig[1]) return validSig[1];
  const goodSig = /\[GNUPG:\]\s+GOODSIG\s+([A-F0-9]{16,40})/i.exec(status);
  if (goodSig && goodSig[1]) return goodSig[1];
  return null;
}

/**
 * Internal barrel for the integrity module folder.
 * The top-level src/integrity.ts re-exports from here to preserve the
 * public import surface.
 */

export {
  computeFreshness,
  computeManifest,
  DEFAULT_STALE_THRESHOLD_DAYS,
  type BPFreshness,
  type BPManifest,
} from "./manifest-check.js";
export { verifyManifestSignature } from "./gpg-verify.js";
export { type ManifestSignatureResult } from "./signature-loader.js";
export {
  verifyManifest,
  type ManifestVerifyResult,
  type VerifyManifestOptions,
} from "./strict-mode-enforcer.js";

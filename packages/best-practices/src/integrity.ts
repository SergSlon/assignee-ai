/**
 * BP manifest integrity + freshness tracking.
 *
 * M1 (Story 12.4 — Freshness): Report the oldest modification time across
 * BP files so the CLI can warn users when rules are stale.
 *
 * M2 (Story 12.6 — Integrity): Compute a SHA-256 manifest of all BP files
 * at load time. Compare against a reference manifest (if present) to detect
 * tampering or corruption.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { SKIP_DIRS } from "./loader.js";

/** Freshness status for the BP library. */
export interface BPFreshness {
  /** ISO string of the oldest file modification time in the library. */
  oldestFileDate: string;
  /** Age of the oldest file in days. */
  oldestAgeDays: number;
  /** Total count of BP YAML files. */
  fileCount: number;
  /** True when oldest file is > stale threshold (default 180 days). */
  isStale: boolean;
  /** Threshold in days that triggered `isStale`. */
  staleThresholdDays: number;
}

/** SHA-256 integrity manifest for the BP library. */
export interface BPManifest {
  /** Version of the manifest format. */
  version: 1;
  /** Overall SHA-256 hash of the sorted per-file hashes. */
  hash: string;
  /** Per-file SHA-256 hashes, keyed by relative path. */
  files: Record<string, string>;
  /** Total count of files in the manifest. */
  count: number;
  /** ISO timestamp when the manifest was generated. */
  generatedAt: string;
}

/** Default staleness threshold: 180 days (~6 months). */
export const DEFAULT_STALE_THRESHOLD_DAYS = 180;

/**
 * Walk the BP directory and collect per-file metadata (mtime + sha256).
 * Mirrors loader.ts walking logic.
 */
function walkBpFiles(
  baseDir: string,
): Array<{ relPath: string; mtime: number; sha256: string }> {
  const files: Array<{ relPath: string; mtime: number; sha256: string }> = [];

  for (const entry of readdirSync(baseDir)) {
    if (entry.startsWith(".") || SKIP_DIRS.has(entry)) continue;

    const entryPath = join(baseDir, entry);
    let isDir: boolean;
    try {
      isDir = statSync(entryPath).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;

    for (const file of readdirSync(entryPath)) {
      if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
      const filePath = join(entryPath, file);
      // TOCTOU-safe: a file listed by readdirSync can be removed before we
      // stat/read it (e.g. concurrent rule reload, atomic rewrite). On
      // ENOENT skip silently — the next walk will pick it up. On any
      // other error log a warning and continue rather than aborting the
      // entire walk and tearing down BP integrity.
      try {
        const stat = statSync(filePath);
        const content = readFileSync(filePath);
        const sha256 = createHash("sha256").update(content).digest("hex");
        files.push({
          relPath: `${entry}/${file}`,
          mtime: stat.mtimeMs,
          sha256,
        });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          // Race with concurrent delete — silently skip.
          continue;
        }
        process.stderr.write(
          `[bp-integrity] warn: failed to read ${filePath}: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
      }
    }
  }

  // Sort by relPath for deterministic manifest ordering
  files.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return files;
}

/**
 * Compute freshness stats for the BP library.
 *
 * @param baseDir - Base directory containing service subdirectories. Defaults to the loader's base.
 * @param staleThresholdDays - Age in days after which the library is considered stale.
 */
export function computeFreshness(
  baseDir?: string,
  staleThresholdDays: number = DEFAULT_STALE_THRESHOLD_DAYS,
): BPFreshness {
  const dir = baseDir ?? join(import.meta.dirname, "..");
  const files = walkBpFiles(dir);

  if (files.length === 0) {
    return {
      oldestFileDate: new Date().toISOString(),
      oldestAgeDays: 0,
      fileCount: 0,
      isStale: false,
      staleThresholdDays,
    };
  }

  // Reduce instead of Math.min(...spread) — spreading large arrays risks
  // hitting the V8 stack-arg limit (~125k elements). reduce is unconditionally
  // safe regardless of file count.
  const oldestMtime = files.reduce(
    (min, f) => (f.mtime < min ? f.mtime : min),
    Infinity,
  );
  const ageMs = Date.now() - oldestMtime;
  const oldestAgeDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));

  return {
    oldestFileDate: new Date(oldestMtime).toISOString(),
    oldestAgeDays,
    fileCount: files.length,
    isStale: oldestAgeDays > staleThresholdDays,
    staleThresholdDays,
  };
}

/**
 * Compute a SHA-256 integrity manifest for the BP library at load time.
 */
export function computeManifest(baseDir?: string): BPManifest {
  const dir = baseDir ?? join(import.meta.dirname, "..");
  const files = walkBpFiles(dir);

  const perFile: Record<string, string> = {};
  for (const f of files) perFile[f.relPath] = f.sha256;

  // Overall hash = SHA-256 of the sorted "relPath:sha256" lines
  const lines = Object.entries(perFile)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, hash]) => `${path}:${hash}`)
    .join("\n");
  const overallHash = createHash("sha256").update(lines).digest("hex");

  return {
    version: 1,
    hash: overallHash,
    files: perFile,
    count: files.length,
    generatedAt: new Date().toISOString(),
  };
}

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
 * Verify a detached GPG signature for a manifest file.
 *
 * Design: signing is OPT-IN. A missing `.sig` file is NOT an error — it
 * simply means the manifest shipped unsigned (current behaviour). GPG not
 * being installed is also not an error here: we downgrade to
 * `verified: false, reason: "gpg not available"` and let the caller decide
 * whether that is acceptable (warn-mode tolerates it, enforce mode with
 * ASSIGNEE_BP_REQUIRE_SIGNATURE rejects it).
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

/**
 * Extract the signing key fingerprint or long key id from GPG --status-fd
 * output. Returns null when no VALIDSIG/GOODSIG line is present.
 */
function extractKeyFromGpgStatus(status: string): string | null {
  const validSig = /\[GNUPG:\]\s+VALIDSIG\s+([A-F0-9]{16,40})/i.exec(status);
  if (validSig && validSig[1]) return validSig[1];
  const goodSig = /\[GNUPG:\]\s+GOODSIG\s+([A-F0-9]{16,40})/i.exec(status);
  if (goodSig && goodSig[1]) return goodSig[1];
  return null;
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

#!/usr/bin/env node
/**
 * Generate manifest.json for the BP library.
 * Run this script after any BP rule change to update the integrity manifest.
 *
 * Usage:
 *   pnpm --filter=@assignee/best-practices run generate-manifest
 *
 * Optional signing (opt-in): when ASSIGNEE_BP_SIGNING_KEY is set, a detached
 * ASCII-armored GPG signature is emitted alongside manifest.json. Verification
 * is opt-in on the consumer side too — unsigned manifests keep working
 * (trust-on-first-use) unless ASSIGNEE_BP_REQUIRE_SIGNATURE is set.
 *
 *   ASSIGNEE_BP_SIGNING_KEY="you@example.com" pnpm --filter=@assignee/best-practices run generate-manifest
 *
 * If `gpg` is not installed the script logs a warning and skips signing
 * rather than failing the build — signing is a release-time opt-in, not a
 * dev prerequisite.
 */

import { writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { computeManifest } from "../dist/integrity.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const baseDir = join(__dirname, "..");
const manifestPath = join(baseDir, "manifest.json");
const sigPath = `${manifestPath}.sig`;

const manifest = computeManifest(baseDir);

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");

console.log(
  `✓ Wrote ${manifestPath}\n  version: ${manifest.version}\n  count:   ${manifest.count} files\n  hash:    ${manifest.hash.slice(0, 16)}…`,
);

// ── Optional GPG signing (opt-in via ASSIGNEE_BP_SIGNING_KEY) ──────────────
const signingKey = process.env["ASSIGNEE_BP_SIGNING_KEY"];
if (signingKey && signingKey.trim().length > 0) {
  // Probe for gpg first; if it's not installed skip with a warning rather
  // than failing the build. Signing is release infra, not a dev gate.
  let gpgAvailable = false;
  try {
    execFileSync("gpg", ["--version"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    gpgAvailable = true;
  } catch {
    process.stderr.write(
      "⚠  ASSIGNEE_BP_SIGNING_KEY set but `gpg` is not installed — skipping signature.\n",
    );
  }

  if (gpgAvailable) {
    // Remove any stale signature first so a failed sign doesn't leave a
    // signature from a previous (now-mismatched) manifest on disk.
    if (existsSync(sigPath)) unlinkSync(sigPath);
    try {
      execFileSync(
        "gpg",
        [
          "--batch",
          "--yes",
          "--detach-sign",
          "--armor",
          "--local-user",
          signingKey,
          "--output",
          sigPath,
          manifestPath,
        ],
        { stdio: ["ignore", "inherit", "inherit"] },
      );
      console.log(`✓ Signed ${sigPath}\n  key:     ${signingKey}`);
    } catch (err) {
      process.stderr.write(
        `⚠  GPG signing failed (key ${signingKey}): ${
          err instanceof Error ? err.message : String(err)
        }\n  Leaving manifest.json unsigned.\n`,
      );
    }
  }
} else {
  console.log(
    "  signing: skipped (set ASSIGNEE_BP_SIGNING_KEY to enable GPG signature)",
  );
}

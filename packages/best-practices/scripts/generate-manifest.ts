#!/usr/bin/env node
/**
 * Generate manifest.json for the BP library.
 * Run this script after any BP rule change to update the integrity manifest.
 *
 * Usage:
 *   pnpm --filter=@assignee/best-practices run generate-manifest
 *
 * Story 50-3: GPG signing ceremony removed. The verifier/signer pair was
 * trust-on-first-use with no consumer enforcement, so it was net negative
 * complexity. Integrity today relies on the SHA-256 `manifest.json` hash
 * computed here and surfaced via doctor's health check.
 */

import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { computeManifest } from "../dist/integrity.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const baseDir = join(__dirname, "..");
const manifestPath = join(baseDir, "manifest.json");

const manifest = computeManifest(baseDir);

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");

console.log(
  `✓ Wrote ${manifestPath}\n  version: ${manifest.version}\n  count:   ${manifest.count} files\n  hash:    ${manifest.hash.slice(0, 16)}…`,
);

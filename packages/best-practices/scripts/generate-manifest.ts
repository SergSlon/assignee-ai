#!/usr/bin/env node
/**
 * Generate manifest.json for the BP library.
 * Run this script after any BP rule change to update the integrity manifest.
 *
 * Usage:
 *   pnpm --filter=@assignee/best-practices run generate-manifest
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

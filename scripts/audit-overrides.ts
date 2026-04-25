#!/usr/bin/env tsx
/**
 * W7-07: audit-overrides.ts
 *
 * Asserts that every key in root package.json `pnpm.overrides` has a
 * corresponding entry in `package.json.overrides-rationale.md`.
 *
 * The rationale sidecar documents the CVE + mitigation for each override,
 * satisfying supply-chain audit requirements. This script enforces that
 * the sidecar stays in sync with the package.json as overrides are added
 * or removed.
 *
 * Exit 0 — all overrides have rationale entries
 * Exit 1 — one or more overrides are missing rationale entries
 */

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname =
  typeof import.meta.dirname !== "undefined"
    ? import.meta.dirname
    : dirname(fileURLToPath(import.meta.url));

const ROOT = join(__dirname, "..");
const PACKAGE_JSON_PATH = join(ROOT, "package.json");
const RATIONALE_PATH = join(ROOT, "package.json.overrides-rationale.md");

interface PackageJson {
  pnpm?: {
    overrides?: Record<string, string>;
  };
}

/**
 * Extract the package name (before any version range) from an override key.
 * e.g. "minimatch@<3.1.5" → "minimatch"
 *      "@hono/node-server" → "@hono/node-server"
 */
function extractPackageName(overrideKey: string): string {
  // Scoped packages start with @
  if (overrideKey.startsWith("@")) {
    // e.g. "@hono/node-server@<1.0.0" → "@hono/node-server"
    const secondAt = overrideKey.indexOf("@", 1);
    if (secondAt === -1) return overrideKey;
    // Check if what follows @ is a version range or another scope segment
    const afterSecondAt = overrideKey.slice(secondAt + 1);
    if (/^[\d<>=~^]/.test(afterSecondAt)) {
      return overrideKey.slice(0, secondAt);
    }
    return overrideKey;
  }
  // Unscoped: "minimatch@<3.1.5" → "minimatch"
  const atIdx = overrideKey.indexOf("@");
  if (atIdx === -1) return overrideKey;
  return overrideKey.slice(0, atIdx);
}

function main(): void {
  // Read package.json
  if (!existsSync(PACKAGE_JSON_PATH)) {
    console.error(
      `✗ overrides audit: package.json not found at ${PACKAGE_JSON_PATH}`,
    );
    process.exit(1);
  }
  const pkg: PackageJson = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8"));
  const overrides = pkg.pnpm?.overrides ?? {};
  const overrideKeys = Object.keys(overrides);

  if (overrideKeys.length === 0) {
    console.log("✓ overrides audit passed — no pnpm.overrides entries found.");
    process.exit(0);
  }

  // Read rationale sidecar
  if (!existsSync(RATIONALE_PATH)) {
    console.error(
      `✗ overrides audit FAILED — rationale sidecar not found: ${RATIONALE_PATH}`,
    );
    console.error(
      `  Create ${RATIONALE_PATH} with a ## section per override key.`,
    );
    process.exit(1);
  }
  const rationale = readFileSync(RATIONALE_PATH, "utf8");

  const missing: string[] = [];
  for (const key of overrideKeys) {
    const packageName = extractPackageName(key);
    // Check for a heading that mentions this package name (case-insensitive)
    // Accepts: "## minimatch@..." or "## minimatch " or "## @hono/node-server"
    const pattern = new RegExp(
      `^##\\s+${packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
      "mi",
    );
    if (!pattern.test(rationale)) {
      missing.push(key);
    }
  }

  if (missing.length === 0) {
    console.log(
      `✓ overrides audit passed — ${overrideKeys.length} override(s) all have rationale entries.`,
    );
    process.exit(0);
  }

  console.error(
    `✗ overrides audit FAILED — ${missing.length} override(s) missing from rationale sidecar:\n`,
  );
  for (const key of missing) {
    console.error(`  Missing: ${key}`);
  }
  console.error(
    `\nAdd a ## ${missing[0]} section to ${RATIONALE_PATH} for each missing entry.`,
  );
  console.error(
    "See the existing entries for the required format (CVE + mitigation + reviewed date).",
  );
  process.exit(1);
}

main();

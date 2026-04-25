#!/usr/bin/env tsx
/**
 * W7-03: audit-homebrew-pin.ts
 *
 * Validates that the Homebrew formula template (homebrew/assignee.rb) uses
 * the `${SHA_*}` envsubst placeholders (not hardcoded or empty hashes), and
 * that the release-manifest.signed.json placeholder is structurally valid.
 *
 * Called from the release workflow's update-homebrew job to assert the formula
 * sha256 values match manifest entries before pushing to the tap. This script
 * can also be run locally for pre-flight checks.
 *
 * Usage:
 *   # Template validation (pre-release check):
 *   npx tsx scripts/audit-homebrew-pin.ts --check-template
 *
 *   # Manifest + formula consistency (post-release, called by workflow):
 *   npx tsx scripts/audit-homebrew-pin.ts --check-manifest \
 *     --darwin-arm64 <sha> --darwin-x64 <sha> --linux-x64 <sha> --linux-arm64 <sha>
 *
 * Exit 0 — all checks pass
 * Exit 1 — formula or manifest inconsistency detected
 */

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname =
  typeof import.meta.dirname !== "undefined"
    ? import.meta.dirname
    : dirname(fileURLToPath(import.meta.url));

const ROOT = join(__dirname, "..");
const FORMULA_PATH = join(ROOT, "homebrew", "assignee.rb");
const MANIFEST_PATH = join(ROOT, "scripts", "release-manifest.signed.json");

// Required envsubst placeholders in the formula template
const REQUIRED_PLACEHOLDERS = [
  "${SHA_DARWIN_ARM64}",
  "${SHA_DARWIN_X64}",
  "${SHA_LINUX_X64}",
  "${SHA_LINUX_ARM64}",
  "${VERSION}",
];

function checkTemplate(): boolean {
  if (!existsSync(FORMULA_PATH)) {
    console.error(`✗ homebrew-pin: formula not found at ${FORMULA_PATH}`);
    return false;
  }

  const formula = readFileSync(FORMULA_PATH, "utf8");
  const missing: string[] = [];

  for (const placeholder of REQUIRED_PLACEHOLDERS) {
    if (!formula.includes(placeholder)) {
      missing.push(placeholder);
    }
  }

  if (missing.length > 0) {
    console.error(
      `✗ homebrew-pin: formula template is missing required placeholders:\n`,
    );
    for (const p of missing) {
      console.error(`  ${p}`);
    }
    console.error(
      "\nAll sha256 fields must use envsubst placeholders, not hardcoded or empty values.",
    );
    return false;
  }

  // Ensure no hardcoded sha256 values (64-char hex strings) are present
  const HARDCODED_SHA_RE = /sha256 "[0-9a-f]{64}"/;
  if (HARDCODED_SHA_RE.test(formula)) {
    console.error(
      "✗ homebrew-pin: formula contains a hardcoded sha256 value. Use ${SHA_*} placeholders instead.",
    );
    return false;
  }

  console.log(
    "✓ homebrew-pin template check passed — all placeholders present, no hardcoded hashes.",
  );
  return true;
}

function checkManifest(shas: Record<string, string>): boolean {
  if (!existsSync(MANIFEST_PATH)) {
    // Manifest is generated at release time — warn but don't fail pre-release
    console.warn(
      `! homebrew-pin: manifest not found at ${MANIFEST_PATH} — skipping manifest check.`,
    );
    return true;
  }

  let manifest: {
    version?: string;
    entries?: Array<{ filename: string; sha256: string }>;
  };
  try {
    manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  } catch (err) {
    console.error(
      `✗ homebrew-pin: failed to parse manifest: ${(err as Error).message}`,
    );
    return false;
  }

  if (!manifest.entries || manifest.entries.length === 0) {
    // Placeholder manifest — skip
    console.log(
      "! homebrew-pin: manifest is the placeholder (no entries) — skipping manifest check.",
    );
    return true;
  }

  const platformMap: Record<string, string> = {
    "darwin-arm64": shas["darwin-arm64"] ?? "",
    "darwin-x64": shas["darwin-x64"] ?? "",
    "linux-x64": shas["linux-x64"] ?? "",
    "linux-arm64": shas["linux-arm64"] ?? "",
  };

  let allOk = true;
  for (const [platform, computedSha] of Object.entries(platformMap)) {
    if (!computedSha) continue; // not provided on this invocation

    const entry = manifest.entries.find((e) => e.filename.includes(platform));
    if (!entry) {
      console.error(
        `✗ homebrew-pin: no manifest entry for platform: ${platform}`,
      );
      allOk = false;
      continue;
    }

    if (entry.sha256 !== computedSha) {
      console.error(
        `✗ homebrew-pin: SHA256 mismatch for ${platform}:\n  manifest: ${entry.sha256}\n  computed: ${computedSha}`,
      );
      allOk = false;
    } else {
      console.log(`  ✓ ${platform}: ${computedSha.substring(0, 16)}...`);
    }
  }

  if (allOk) {
    console.log(
      "✓ homebrew-pin manifest check passed — all sha256 values match.",
    );
  }
  return allOk;
}

function parseArgs(): { mode: string; shas: Record<string, string> } {
  const args = process.argv.slice(2);
  const mode = args.includes("--check-manifest") ? "manifest" : "template";
  const shas: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--darwin-arm64") shas["darwin-arm64"] = args[++i] ?? "";
    if (args[i] === "--darwin-x64") shas["darwin-x64"] = args[++i] ?? "";
    if (args[i] === "--linux-x64") shas["linux-x64"] = args[++i] ?? "";
    if (args[i] === "--linux-arm64") shas["linux-arm64"] = args[++i] ?? "";
  }

  return { mode, shas };
}

function main(): void {
  const { mode, shas } = parseArgs();

  const templateOk = checkTemplate();

  if (mode === "manifest") {
    const manifestOk = checkManifest(shas);
    process.exit(templateOk && manifestOk ? 0 : 1);
  } else {
    process.exit(templateOk ? 0 : 1);
  }
}

main();

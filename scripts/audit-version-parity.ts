/**
 * audit-version-parity.ts — W8-S4 (closes M-γ-20)
 *
 * Verifies that all publishable workspace packages carry the same `version`
 * as the release tag being cut.  Exits 0 on full parity, exits 1 and prints
 * a human-readable diff on any mismatch.
 *
 * Usage (CI / release.yml):
 *   npx tsx scripts/audit-version-parity.ts --expected-version v0.1.4
 *   npx tsx scripts/audit-version-parity.ts --expected-version 0.1.4
 *
 * The leading "v" is always stripped before comparison so both forms work.
 *
 * Invariant 5 — non-release branches:
 *   If `--expected-version` is omitted, or the supplied value does not look
 *   like semver (X.Y.Z, no extra qualifiers), the script exits 0 silently so
 *   branch-level CI runs are unaffected.
 *
 * WARNING: Do NOT import from @assignee/core or workspace packages here.
 * This script runs outside the workspace build context.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PackageParity {
  /** Relative path from workspace root, e.g. "packages/core" */
  packageDir: string;
  /** npm package name, e.g. "@assignee/core" */
  packageName: string;
  /** The version read from package.json */
  actualVersion: string;
  /** The expected version (leading v stripped) */
  expectedVersion: string;
  /** True when actualVersion === expectedVersion */
  match: boolean;
}

export interface ParityResult {
  expectedVersion: string;
  packages: PackageParity[];
  allMatch: boolean;
  mismatches: PackageParity[];
}

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * The four publishable packages whose versions must match the release tag.
 * Paths are relative to the workspace root.
 */
export const PUBLISHABLE_PACKAGES = [
  "packages/core",
  "packages/best-practices",
  "apps/cli",
  "apps/mcp-server",
] as const;

/** Matches a bare semver string: MAJOR.MINOR.PATCH (with optional pre-release). */
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-.].+)?$/;

// ── Core logic (exported for unit tests) ─────────────────────────────────────

/**
 * Strip a leading "v" or "V" from a version string.
 * "v0.1.4" → "0.1.4"
 * "0.1.4"  → "0.1.4"
 */
export function normaliseVersion(raw: string): string {
  return raw.replace(/^[vV]/, "");
}

/**
 * Return true when `version` looks like semver (X.Y.Z…).
 * Non-semver values (branch names, "main", empty string) return false.
 */
export function isSemver(version: string): boolean {
  return SEMVER_RE.test(version);
}

/**
 * Read the `version` field from a package.json file.
 * Throws if the file is missing or has no `version` field.
 */
export function readPackageVersion(pkgJsonPath: string): {
  name: string;
  version: string;
} {
  const raw = fs.readFileSync(pkgJsonPath, "utf-8");
  const pkg = JSON.parse(raw) as { name?: string; version?: string };
  if (!pkg.version) {
    throw new Error(`No "version" field found in ${pkgJsonPath}`);
  }
  return { name: pkg.name ?? pkgJsonPath, version: pkg.version };
}

/**
 * Check version parity across all publishable packages.
 *
 * @param expectedVersionRaw  The release tag (e.g. "v0.1.4" or "0.1.4").
 * @param workspaceRoot       Absolute path to the monorepo root.
 * @returns ParityResult describing every package and any mismatches.
 */
export function checkVersionParity(
  expectedVersionRaw: string,
  workspaceRoot: string,
): ParityResult {
  const expectedVersion = normaliseVersion(expectedVersionRaw);
  const packages: PackageParity[] = [];

  for (const pkgDir of PUBLISHABLE_PACKAGES) {
    const pkgJsonPath = path.join(workspaceRoot, pkgDir, "package.json");
    const { name: packageName, version: actualVersion } =
      readPackageVersion(pkgJsonPath);
    const match = actualVersion === expectedVersion;
    packages.push({
      packageDir: pkgDir,
      packageName,
      actualVersion,
      expectedVersion,
      match,
    });
  }

  const mismatches = packages.filter((p) => !p.match);
  return {
    expectedVersion,
    packages,
    allMatch: mismatches.length === 0,
    mismatches,
  };
}

/**
 * Format a human-readable parity report for stdout / stderr.
 */
export function formatParityReport(result: ParityResult): string {
  const lines: string[] = [];
  lines.push(`Version parity check — expected: ${result.expectedVersion}`, "");
  for (const pkg of result.packages) {
    const status = pkg.match ? "✓" : "✗";
    const detail = pkg.match
      ? pkg.actualVersion
      : `${pkg.actualVersion} ≠ ${pkg.expectedVersion}`;
    lines.push(
      `  ${status}  ${pkg.packageName} (${pkg.packageDir})  →  ${detail}`,
    );
  }
  if (!result.allMatch) {
    lines.push(
      "",
      `ERROR: ${result.mismatches.length} package(s) do not match the release tag.`,
      "       Bump every package.json version to match the tag before releasing.",
    );
  } else {
    lines.push("", "All packages match the release tag.");
  }
  return lines.join("\n");
}

// ── CLI entry point ───────────────────────────────────────────────────────────

/**
 * Parse --expected-version <value> from process.argv.
 * Returns undefined if the flag is absent.
 */
export function parseExpectedVersion(
  argv: readonly string[],
): string | undefined {
  const idx = argv.indexOf("--expected-version");
  if (idx === -1 || idx + 1 >= argv.length) return undefined;
  return argv[idx + 1];
}

// Only run when executed directly (not when imported by tests).
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) ===
    path.resolve(url.fileURLToPath(import.meta.url));

if (isMain) {
  const rawVersion = parseExpectedVersion(process.argv);

  if (!rawVersion) {
    // No --expected-version supplied — treat as non-release context, exit 0.
    process.exit(0);
  }

  const normalised = normaliseVersion(rawVersion);

  if (!isSemver(normalised)) {
    // Looks like a branch name or other non-semver ref — exit 0 (invariant 5).
    process.exit(0);
  }

  // Workspace root is two levels above this file (scripts/audit-version-parity.ts)
  const workspaceRoot = path.resolve(
    path.dirname(url.fileURLToPath(import.meta.url)),
    "..",
  );

  let result: ParityResult;
  try {
    result = checkVersionParity(rawVersion, workspaceRoot);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`audit-version-parity: fatal: ${msg}\n`);
    process.exit(1);
  }

  const report = formatParityReport(result);
  process.stdout.write(report + "\n");

  if (!result.allMatch) {
    process.exit(1);
  }

  process.exit(0);
}

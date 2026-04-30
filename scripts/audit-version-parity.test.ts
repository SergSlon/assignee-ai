/**
 * Unit tests for audit-version-parity.ts — W8-S4 (M-γ-20)
 *
 * Uses a temporary on-disk fixture directory so `readPackageVersion` reads
 * real files — no mocking of the fs module.  All test data uses real semver
 * values matching the actual workspace baseline (0.1.0).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  normaliseVersion,
  isSemver,
  readPackageVersion,
  checkVersionParity,
  formatParityReport,
  parseExpectedVersion,
  PUBLISHABLE_PACKAGES,
} from "./audit-version-parity.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Create a temporary workspace directory that mirrors the real monorepo
 * structure.  Each publishable package directory is seeded with a
 * package.json containing the given version.
 */
function createFakeWorkspace(versions: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parity-test-"));
  for (const pkgDir of PUBLISHABLE_PACKAGES) {
    const dir = path.join(root, pkgDir);
    fs.mkdirSync(dir, { recursive: true });
    const version = versions[pkgDir] ?? "0.1.0";
    const name = `@assignee/${pkgDir.split("/").pop()}`;
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name, version }, null, 2),
    );
  }
  return root;
}

/** Remove the temporary workspace directory. */
function cleanupWorkspace(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

// ── normaliseVersion ──────────────────────────────────────────────────────────

describe("normaliseVersion", () => {
  it("strips a leading lowercase v", () => {
    expect(normaliseVersion("v0.1.4")).toBe("0.1.4");
  });

  it("strips a leading uppercase V", () => {
    expect(normaliseVersion("V1.2.3")).toBe("1.2.3");
  });

  it("is a no-op when there is no leading v", () => {
    expect(normaliseVersion("0.1.4")).toBe("0.1.4");
  });

  it("handles pre-release labels", () => {
    expect(normaliseVersion("v1.0.0-alpha.1")).toBe("1.0.0-alpha.1");
  });

  it("does not strip v that is not at the start", () => {
    expect(normaliseVersion("1.0.0-v2")).toBe("1.0.0-v2");
  });
});

// ── isSemver ──────────────────────────────────────────────────────────────────

describe("isSemver", () => {
  it("recognises X.Y.Z as semver", () => {
    expect(isSemver("0.1.4")).toBe(true);
    expect(isSemver("1.0.0")).toBe(true);
    expect(isSemver("12.34.56")).toBe(true);
  });

  it("recognises X.Y.Z with pre-release as semver", () => {
    expect(isSemver("1.0.0-alpha.1")).toBe(true);
    expect(isSemver("0.1.0-rc.2")).toBe(true);
  });

  it("rejects branch names", () => {
    expect(isSemver("main")).toBe(false);
    expect(isSemver("feature/my-branch")).toBe(false);
  });

  it("rejects version strings that still have a leading v", () => {
    // normaliseVersion should be called first; raw tags with v should fail
    expect(isSemver("v0.1.4")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isSemver("")).toBe(false);
  });
});

// ── readPackageVersion ────────────────────────────────────────────────────────

describe("readPackageVersion", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pkg-ver-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads name and version from a valid package.json", () => {
    const pkgPath = path.join(tmpDir, "package.json");
    fs.writeFileSync(
      pkgPath,
      JSON.stringify({ name: "@assignee/core", version: "0.1.0" }),
    );
    const result = readPackageVersion(pkgPath);
    expect(result.name).toBe("@assignee/core");
    expect(result.version).toBe("0.1.0");
  });

  it("throws when the file is missing", () => {
    expect(() =>
      readPackageVersion(path.join(tmpDir, "nonexistent.json")),
    ).toThrow();
  });

  it("throws when version field is absent", () => {
    const pkgPath = path.join(tmpDir, "package.json");
    fs.writeFileSync(pkgPath, JSON.stringify({ name: "@assignee/core" }));
    expect(() => readPackageVersion(pkgPath)).toThrow(/No "version"/);
  });
});

// ── checkVersionParity — all-match case ──────────────────────────────────────

describe("checkVersionParity — all packages match", () => {
  let workspace: string;

  beforeEach(() => {
    // All four packages pinned to 0.1.4
    workspace = createFakeWorkspace({
      "packages/core": "0.1.4",
      "packages/best-practices": "0.1.4",
      "apps/cli": "0.1.4",
      "apps/mcp-server": "0.1.4",
    });
  });

  afterEach(() => cleanupWorkspace(workspace));

  it("returns allMatch=true when every package version equals the tag", () => {
    const result = checkVersionParity("v0.1.4", workspace);
    expect(result.allMatch).toBe(true);
    expect(result.mismatches).toHaveLength(0);
  });

  it("normalises the leading v before comparison", () => {
    // "v0.1.4" and "0.1.4" must both resolve to the same check
    const withV = checkVersionParity("v0.1.4", workspace);
    const withoutV = checkVersionParity("0.1.4", workspace);
    expect(withV.allMatch).toBe(true);
    expect(withoutV.allMatch).toBe(true);
  });

  it("reports the correct expectedVersion in the result", () => {
    const result = checkVersionParity("v0.1.4", workspace);
    expect(result.expectedVersion).toBe("0.1.4");
  });

  it("includes all four publishable packages in the result", () => {
    const result = checkVersionParity("0.1.4", workspace);
    expect(result.packages).toHaveLength(PUBLISHABLE_PACKAGES.length);
    const dirs = result.packages.map((p) => p.packageDir);
    for (const pkg of PUBLISHABLE_PACKAGES) {
      expect(dirs).toContain(pkg);
    }
  });
});

// ── checkVersionParity — mismatch cases ──────────────────────────────────────

describe("checkVersionParity — one or more mismatches", () => {
  let workspace: string;

  afterEach(() => cleanupWorkspace(workspace));

  it("reports allMatch=false when one package is behind", () => {
    workspace = createFakeWorkspace({
      "packages/core": "0.1.3", // stale
      "packages/best-practices": "0.1.4",
      "apps/cli": "0.1.4",
      "apps/mcp-server": "0.1.4",
    });
    const result = checkVersionParity("v0.1.4", workspace);
    expect(result.allMatch).toBe(false);
    expect(result.mismatches).toHaveLength(1);
    expect(result.mismatches[0]!.packageDir).toBe("packages/core");
    expect(result.mismatches[0]!.actualVersion).toBe("0.1.3");
  });

  it("prints the mismatched package name in the report", () => {
    workspace = createFakeWorkspace({
      "packages/core": "0.1.3",
      "packages/best-practices": "0.1.4",
      "apps/cli": "0.1.4",
      "apps/mcp-server": "0.1.4",
    });
    const result = checkVersionParity("v0.1.4", workspace);
    const report = formatParityReport(result);
    expect(report).toContain("packages/core");
    expect(report).toContain("0.1.3");
    expect(report).toContain("0.1.4");
    expect(report).toContain("ERROR");
  });

  it("reports all mismatched packages when multiple are behind", () => {
    workspace = createFakeWorkspace({
      "packages/core": "0.1.3",
      "packages/best-practices": "0.1.2",
      "apps/cli": "0.1.4",
      "apps/mcp-server": "0.1.4",
    });
    const result = checkVersionParity("v0.1.4", workspace);
    expect(result.allMatch).toBe(false);
    expect(result.mismatches).toHaveLength(2);
    const mismatchDirs = result.mismatches.map((m) => m.packageDir);
    expect(mismatchDirs).toContain("packages/core");
    expect(mismatchDirs).toContain("packages/best-practices");
  });

  it("flags packages that are AHEAD of the tag too", () => {
    workspace = createFakeWorkspace({
      "packages/core": "0.2.0", // ahead
      "packages/best-practices": "0.1.4",
      "apps/cli": "0.1.4",
      "apps/mcp-server": "0.1.4",
    });
    const result = checkVersionParity("v0.1.4", workspace);
    expect(result.allMatch).toBe(false);
    expect(result.mismatches[0]!.packageDir).toBe("packages/core");
  });
});

// ── formatParityReport ────────────────────────────────────────────────────────

describe("formatParityReport", () => {
  it("includes success message when all packages match", () => {
    const result = checkVersionParity(
      "0.1.0",
      createFakeWorkspace({
        "packages/core": "0.1.0",
        "packages/best-practices": "0.1.0",
        "apps/cli": "0.1.0",
        "apps/mcp-server": "0.1.0",
      }),
    );
    const report = formatParityReport(result);
    expect(report).toContain("All packages match");
    expect(report).not.toContain("ERROR");
  });

  it("contains the expected version in the header", () => {
    const workspace = createFakeWorkspace({
      "packages/core": "1.2.3",
      "packages/best-practices": "1.2.3",
      "apps/cli": "1.2.3",
      "apps/mcp-server": "1.2.3",
    });
    const result = checkVersionParity("v1.2.3", workspace);
    const report = formatParityReport(result);
    expect(report).toContain("1.2.3");
    cleanupWorkspace(workspace);
  });
});

// ── parseExpectedVersion ──────────────────────────────────────────────────────

describe("parseExpectedVersion", () => {
  it("parses --expected-version from argv", () => {
    expect(
      parseExpectedVersion([
        "node",
        "script.ts",
        "--expected-version",
        "v0.1.4",
      ]),
    ).toBe("v0.1.4");
  });

  it("returns undefined when the flag is absent", () => {
    expect(parseExpectedVersion(["node", "script.ts"])).toBeUndefined();
  });

  it("returns undefined when --expected-version has no following argument", () => {
    expect(
      parseExpectedVersion(["node", "script.ts", "--expected-version"]),
    ).toBeUndefined();
  });

  it("handles --expected-version without leading v", () => {
    expect(
      parseExpectedVersion([
        "node",
        "script.ts",
        "--expected-version",
        "0.1.4",
      ]),
    ).toBe("0.1.4");
  });
});

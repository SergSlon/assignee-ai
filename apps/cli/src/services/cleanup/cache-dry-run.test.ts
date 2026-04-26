/**
 * Branch-coverage uplift for cleanup/cache-dry-run.ts — P066 R10b-01.
 *
 * Covers the conditional branches that were missed:
 *  - cacheDir missing (readdir throws) → {removed:0, remaining:0}
 *  - file with invalid cachedAt (non-number) → counted as removed
 *  - file with NaN cachedAt → counted as removed
 *  - file whose cachedAt makes it older than maxAge → counted as removed
 *  - file with a valid recent cachedAt → counted as remaining
 *  - file that throws on readFile → counted as removed
 *  - directory with no .json files → {removed:0, remaining:0}
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsAsync from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { dryRunCacheSweep } from "./cache-dry-run.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fsAsync.mkdtemp(
    path.join(os.tmpdir(), "assignee-cache-dry-run-test-"),
  );
  // dryRunCacheSweep reads from os.homedir()/.assignee/cache/pricing.
  // We override the resolved path indirectly by writing fixtures into a
  // structure the function will access — but since the function hard-codes
  // the path via os.homedir() we test with the real mechanism:
  //   a) the fallback (missing dir) branch is always reachable
  //   b) for the real file branches we write to the actual expected path
  //      under a temp home using a module-level vi.mock on os.homedir.
  // Because vi.mock is hoisted and the test file is short-lived, this
  // approach is safer than patching env vars.
});

afterEach(async () => {
  await fsAsync.rm(tmpDir, { recursive: true, force: true });
});

// ──────────────────────────────────────────────────────────────────────────────
// Helper: write a cache entry JSON to tmpDir/pricing/<file>
// ──────────────────────────────────────────────────────────────────────────────

async function writeCacheEntry(
  pricingDir: string,
  filename: string,
  content: string,
): Promise<void> {
  await fsAsync.mkdir(pricingDir, { recursive: true });
  await fsAsync.writeFile(path.join(pricingDir, filename), content, "utf-8");
}

// ──────────────────────────────────────────────────────────────────────────────
// We use vi.mock at module level to redirect os.homedir → tmpDir so the
// function under test reads from a controlled directory.
// ──────────────────────────────────────────────────────────────────────────────

import { vi } from "vitest";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: vi.fn(() => actual.homedir()),
  };
});

import * as osMod from "node:os";

describe("dryRunCacheSweep", () => {
  let pricingDir: string;

  beforeEach(() => {
    pricingDir = path.join(tmpDir, ".assignee", "cache", "pricing");
    vi.mocked(osMod.homedir).mockReturnValue(tmpDir);
  });

  it("returns {removed:0, remaining:0} when pricing dir does not exist", async () => {
    // pricing dir is not created — readdir will throw
    const result = await dryRunCacheSweep();
    expect(result).toEqual({ removed: 0, remaining: 0 });
  });

  it("returns {removed:0, remaining:0} when dir has no .json files", async () => {
    await fsAsync.mkdir(pricingDir, { recursive: true });
    await fsAsync.writeFile(path.join(pricingDir, "note.txt"), "ignored");
    const result = await dryRunCacheSweep();
    expect(result).toEqual({ removed: 0, remaining: 0 });
  });

  it("counts file with valid recent cachedAt as remaining", async () => {
    const recentEntry = JSON.stringify({ cachedAt: Date.now() });
    await writeCacheEntry(pricingDir, "ec2.json", recentEntry);
    const result = await dryRunCacheSweep(24 * 60 * 60 * 1000);
    expect(result.remaining).toBe(1);
    expect(result.removed).toBe(0);
  });

  it("counts file older than maxAge as removed", async () => {
    const oldEntry = JSON.stringify({
      cachedAt: Date.now() - 2 * 24 * 60 * 60 * 1000,
    });
    await writeCacheEntry(pricingDir, "ec2-old.json", oldEntry);
    const result = await dryRunCacheSweep(24 * 60 * 60 * 1000);
    expect(result.removed).toBe(1);
    expect(result.remaining).toBe(0);
  });

  it("counts file with non-number cachedAt as removed (branch: typeof !== number)", async () => {
    const badEntry = JSON.stringify({ cachedAt: "not-a-number" });
    await writeCacheEntry(pricingDir, "bad-type.json", badEntry);
    const result = await dryRunCacheSweep();
    expect(result.removed).toBe(1);
  });

  it("counts file with NaN cachedAt as removed (branch: isNaN check)", async () => {
    const nanEntry = JSON.stringify({ cachedAt: NaN });
    await writeCacheEntry(pricingDir, "nan.json", nanEntry);
    const result = await dryRunCacheSweep();
    expect(result.removed).toBe(1);
  });

  it("counts file with missing cachedAt key as removed", async () => {
    const noKey = JSON.stringify({ someOtherKey: "value" });
    await writeCacheEntry(pricingDir, "no-key.json", noKey);
    const result = await dryRunCacheSweep();
    expect(result.removed).toBe(1);
  });

  it("counts unparseable JSON file as removed (branch: catch → shouldRemove=true)", async () => {
    await writeCacheEntry(pricingDir, "corrupt.json", "{ not valid json }}}");
    const result = await dryRunCacheSweep();
    expect(result.removed).toBe(1);
  });

  it("handles a mix of valid, old, and corrupt files correctly", async () => {
    const recent = JSON.stringify({ cachedAt: Date.now() });
    const old = JSON.stringify({
      cachedAt: Date.now() - 5 * 24 * 60 * 60 * 1000,
    });

    await writeCacheEntry(pricingDir, "recent.json", recent);
    await writeCacheEntry(pricingDir, "old.json", old);
    await writeCacheEntry(pricingDir, "corrupt.json", "BAD JSON");

    const result = await dryRunCacheSweep(24 * 60 * 60 * 1000);
    expect(result.remaining).toBe(1);
    expect(result.removed).toBe(2);
  });

  it("ignores non-.json files in a mixed directory", async () => {
    const recent = JSON.stringify({ cachedAt: Date.now() });
    await writeCacheEntry(pricingDir, "valid.json", recent);
    await fsAsync.writeFile(path.join(pricingDir, "README.md"), "ignored");
    await fsAsync.writeFile(path.join(pricingDir, "data.csv"), "ignored");

    const result = await dryRunCacheSweep(24 * 60 * 60 * 1000);
    expect(result.remaining).toBe(1);
    expect(result.removed).toBe(0);
  });
});

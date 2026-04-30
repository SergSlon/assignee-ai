/**
 * Tests for sweepExpiredPrices (Story 33.1).
 * Uses fs.mkdtemp for isolated temp dirs.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { sweepExpiredPrices } from "./price-cache.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), "assignee-price-cache-test-"),
  );
});

afterEach(async () => {
  await fsPromises.rm(tmpDir, { recursive: true, force: true });
});

function writeCacheEntry(
  fileName: string,
  cachedAt: number,
  data: unknown = { price: "0.023" },
): void {
  fs.writeFileSync(
    path.join(tmpDir, fileName),
    JSON.stringify({
      cachedAt,
      data,
      serviceCode: "AmazonS3",
      filtersHash: "abc123",
    }),
    "utf-8",
  );
}

describe("sweepExpiredPrices (Story 33.1)", () => {
  it("deletes all expired entries", () => {
    const oneDayAgo = Date.now() - 25 * 60 * 60 * 1000; // 25h ago
    writeCacheEntry("AmazonS3-aaa.json", oneDayAgo);
    writeCacheEntry("AmazonEC2-bbb.json", oneDayAgo);

    const result = sweepExpiredPrices(24 * 60 * 60 * 1000, tmpDir);
    expect(result).toEqual({ removed: 2, remaining: 0 });

    const remaining = fs.readdirSync(tmpDir);
    expect(remaining).toHaveLength(0);
  });

  it("keeps all valid (non-expired) entries", () => {
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    writeCacheEntry("AmazonS3-aaa.json", fiveMinAgo);
    writeCacheEntry("AmazonEC2-bbb.json", fiveMinAgo);

    const result = sweepExpiredPrices(24 * 60 * 60 * 1000, tmpDir);
    expect(result).toEqual({ removed: 0, remaining: 2 });

    const remaining = fs.readdirSync(tmpDir);
    expect(remaining).toHaveLength(2);
  });

  it("handles mixed expired and valid entries", () => {
    const expired = Date.now() - 25 * 60 * 60 * 1000;
    const valid = Date.now() - 5 * 60 * 1000;
    writeCacheEntry("AmazonS3-expired.json", expired);
    writeCacheEntry("AmazonEC2-valid.json", valid);

    const result = sweepExpiredPrices(24 * 60 * 60 * 1000, tmpDir);
    expect(result).toEqual({ removed: 1, remaining: 1 });

    const remaining = fs.readdirSync(tmpDir);
    expect(remaining).toEqual(["AmazonEC2-valid.json"]);
  });

  it("deletes corrupt/unparseable cache files", () => {
    fs.writeFileSync(
      path.join(tmpDir, "corrupt-aaa.json"),
      "{not valid json",
      "utf-8",
    );
    writeCacheEntry("AmazonS3-valid.json", Date.now());

    const result = sweepExpiredPrices(24 * 60 * 60 * 1000, tmpDir);
    expect(result).toEqual({ removed: 1, remaining: 1 });
  });

  it("returns zeros for empty directory", () => {
    const result = sweepExpiredPrices(24 * 60 * 60 * 1000, tmpDir);
    expect(result).toEqual({ removed: 0, remaining: 0 });
  });

  it("returns zeros for non-existent directory", () => {
    const result = sweepExpiredPrices(
      24 * 60 * 60 * 1000,
      path.join(tmpDir, "nonexistent"),
    );
    expect(result).toEqual({ removed: 0, remaining: 0 });
  });

  it("deletes files with missing cachedAt field", () => {
    fs.writeFileSync(
      path.join(tmpDir, "no-cached-at.json"),
      JSON.stringify({ data: {}, serviceCode: "test" }),
      "utf-8",
    );

    const result = sweepExpiredPrices(24 * 60 * 60 * 1000, tmpDir);
    expect(result).toEqual({ removed: 1, remaining: 0 });
  });

  it("ignores non-json files", () => {
    fs.writeFileSync(
      path.join(tmpDir, "readme.txt"),
      "not a cache file",
      "utf-8",
    );
    writeCacheEntry("AmazonS3-valid.json", Date.now());

    const result = sweepExpiredPrices(24 * 60 * 60 * 1000, tmpDir);
    expect(result).toEqual({ removed: 0, remaining: 1 });

    // txt file should still be there
    const remaining = fs.readdirSync(tmpDir);
    expect(remaining).toContain("readme.txt");
  });
});

// L-A3 regression: cache key hashing must use SHA-256 (not MD5) so
// compliance scanners that flag MD5 unconditionally pass. The output is
// still sliced to 12 hex chars to keep filenames short. We assert that
// the cached file's name uses the SHA-256 prefix of the canonical key,
// not the MD5 prefix.
describe("price-cache hash function (L-A3)", () => {
  let homeDir: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;

  beforeEach(async () => {
    homeDir = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), "assignee-pricecache-home-"),
    );
    originalHome = process.env["HOME"];
    originalUserProfile = process.env["USERPROFILE"];
    process.env["HOME"] = homeDir;
    // os.homedir() prefers USERPROFILE on Windows; HOME alone only works on
    // POSIX. Setting both keeps the test deterministic on every platform.
    process.env["USERPROFILE"] = homeDir;
    vi.resetModules();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (originalHome === undefined) {
      delete process.env["HOME"];
    } else {
      process.env["HOME"] = originalHome;
    }
    if (originalUserProfile === undefined) {
      delete process.env["USERPROFILE"];
    } else {
      process.env["USERPROFILE"] = originalUserProfile;
    }
    await fsPromises
      .rm(homeDir, { recursive: true, force: true })
      .catch(() => {});
  });

  it("setCachedPrice writes a file whose name uses SHA-256 (not MD5) prefix", async () => {
    // os.homedir() prefers process.env.HOME on Unix, so re-importing the
    // module after setting HOME yields a CACHE_DIR rooted at our temp dir.
    vi.resetModules();
    const { setCachedPrice: setCached } = await import("./price-cache.js");

    const serviceCode = "AmazonS3";
    const filters = [{ Type: "TERM_MATCH", Field: "location", Value: "EU" }];
    const data = {
      PriceList: ['{"product":{"sku":"abc"},"terms":{}}'],
    };

    setCached(serviceCode, filters, data);

    const cacheDir = path.join(homeDir, ".assignee", "cache", "pricing");
    const files = fs.readdirSync(cacheDir);
    expect(files).toHaveLength(1);
    const fileName = files[0]!;

    // Compute the expected SHA-256 prefix for this serviceCode + filters.
    const key = JSON.stringify({ serviceCode, filters });
    const sha256Prefix = crypto
      .createHash("sha256")
      .update(key)
      .digest("hex")
      .slice(0, 12);
    const md5Prefix = crypto
      .createHash("md5")
      .update(key)
      .digest("hex")
      .slice(0, 12);

    expect(fileName).toBe(`${serviceCode}-${sha256Prefix}.json`);
    expect(fileName).not.toBe(`${serviceCode}-${md5Prefix}.json`);
  });

  it("getCachedPrice round-trips a value written with the sha256 hash", async () => {
    vi.resetModules();
    const { setCachedPrice: setCached, getCachedPrice: getCached } =
      await import("./price-cache.js");

    const serviceCode = "AmazonEC2";
    const filters = [
      { Type: "TERM_MATCH", Field: "instanceType", Value: "t3.micro" },
    ];
    const data = { hourlyUsd: 0.0104 };

    setCached(serviceCode, filters, data);
    const got = getCached(serviceCode, filters);
    expect(got).toEqual(data);
  });
});

// M-α-14: File permission tests — cache dir must be 0o700, cache files must be 0o600.
describe("price-cache file permissions (M-α-14)", () => {
  let homeDir: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;

  beforeEach(async () => {
    homeDir = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), "assignee-pricecache-perms-"),
    );
    originalHome = process.env["HOME"];
    originalUserProfile = process.env["USERPROFILE"];
    process.env["HOME"] = homeDir;
    process.env["USERPROFILE"] = homeDir;
    vi.resetModules();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (originalHome === undefined) {
      delete process.env["HOME"];
    } else {
      process.env["HOME"] = originalHome;
    }
    if (originalUserProfile === undefined) {
      delete process.env["USERPROFILE"];
    } else {
      process.env["USERPROFILE"] = originalUserProfile;
    }
    await fsPromises
      .rm(homeDir, { recursive: true, force: true })
      .catch(() => {});
  });

  it("creates the cache directory with mode 0o700 (owner-only)", async () => {
    // Skip on Windows: chmod semantics are not supported.
    if (process.platform === "win32") return;

    vi.resetModules();
    const { setCachedPrice: setCached } = await import("./price-cache.js");
    setCached("AmazonS3", [], { price: "0.023" });

    const cacheDir = path.join(homeDir, ".assignee", "cache", "pricing");
    const stat = fs.statSync(cacheDir);
    // Extract the permission bits (lower 12 bits of mode).
    const perms = stat.mode & 0o777;
    expect(perms).toBe(0o700);
  });

  it("writes cache files with mode 0o600 (owner read/write only)", async () => {
    // Skip on Windows: chmod semantics are not supported.
    if (process.platform === "win32") return;

    vi.resetModules();
    const { setCachedPrice: setCached } = await import("./price-cache.js");
    const serviceCode = "AmazonEC2";
    const filters = [
      { Type: "TERM_MATCH", Field: "instanceType", Value: "t3.micro" },
    ];
    setCached(serviceCode, filters, { hourlyUsd: 0.0104 });

    const cacheDir = path.join(homeDir, ".assignee", "cache", "pricing");
    const files = fs.readdirSync(cacheDir);
    expect(files).toHaveLength(1);

    const fileStat = fs.statSync(path.join(cacheDir, files[0]!));
    const perms = fileStat.mode & 0o777;
    expect(perms).toBe(0o600);
  });
});

// Story 50-2: Windows-path coverage. `os.homedir()` prefers `USERPROFILE`
// on win32 and `HOME` on POSIX. The `HOME`-only tests above cover the
// POSIX branch; this block exercises the win32 branch by stubbing
// `os.platform` to "win32" and seeding `USERPROFILE` so the path
// resolution code is actually exercised on non-Windows CI hosts.
describe("price-cache Windows HOME resolution", () => {
  let userProfileDir: string;
  let originalUserProfile: string | undefined;
  let originalHome: string | undefined;

  beforeEach(async () => {
    userProfileDir = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), "assignee-pricecache-winhome-"),
    );
    originalUserProfile = process.env["USERPROFILE"];
    originalHome = process.env["HOME"];
    // Seed the Windows home var; clear the POSIX one so os.homedir()
    // cannot silently fall through to HOME on the test host.
    process.env["USERPROFILE"] = userProfileDir;
    delete process.env["HOME"];
    vi.resetModules();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (originalUserProfile === undefined) {
      delete process.env["USERPROFILE"];
    } else {
      process.env["USERPROFILE"] = originalUserProfile;
    }
    if (originalHome === undefined) {
      delete process.env["HOME"];
    } else {
      process.env["HOME"] = originalHome;
    }
    await fsPromises
      .rm(userProfileDir, { recursive: true, force: true })
      .catch(() => {});
  });

  it("resolves the cache dir under USERPROFILE when os.homedir() returns it", async () => {
    // We cannot spy on os.platform directly under ESM (Module namespace
    // is non-configurable), so instead we stub `os.homedir()` to mirror
    // what Node does natively on win32: return the USERPROFILE env var.
    // This exercises the USERPROFILE env-var path so a Windows host
    // running the test under GitBash/WSL cannot accidentally break it.
    //
    // vi.doMock() patches the module loader before price-cache imports it.
    vi.doMock("node:os", async () => {
      const actual = await vi.importActual<typeof import("node:os")>("node:os");
      return {
        ...actual,
        homedir: () => process.env["USERPROFILE"] ?? "",
      };
    });

    vi.resetModules();
    const { setCachedPrice: setCached } = await import("./price-cache.js");

    const serviceCode = "AmazonS3";
    const filters = [{ Type: "TERM_MATCH", Field: "location", Value: "EU" }];
    const data = { PriceList: ['{"product":{"sku":"winprofile"},"terms":{}}'] };

    setCached(serviceCode, filters, data);

    const cacheDir = path.join(userProfileDir, ".assignee", "cache", "pricing");
    const files = fs.readdirSync(cacheDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(
      new RegExp(`^${serviceCode}-[0-9a-f]{12}\\.json$`),
    );

    vi.doUnmock("node:os");
  });
});

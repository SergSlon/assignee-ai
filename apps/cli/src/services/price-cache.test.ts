/**
 * Tests for sweepExpiredPrices (Story 33.1).
 * Uses fs.mkdtemp for isolated temp dirs.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
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

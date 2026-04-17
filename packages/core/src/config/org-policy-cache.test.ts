import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type MockInstance,
} from "vitest";
import * as fs from "node:fs/promises";
import { fetchOrgPolicy } from "./org-policy-cache.js";
import type { OrgResourceConfig } from "./resource-policy.js";

vi.mock("node:fs/promises");

const mockedFs = vi.mocked(fs);

describe("org-policy-cache", () => {
  let stderrSpy: MockInstance;
  let fetchSpy: MockInstance;

  const samplePolicy: OrgResourceConfig = {
    "AWS::S3::Bucket": {
      PublicAccessBlockConfiguration: { policy: "locked", value: true },
    },
  };

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    fetchSpy = vi.spyOn(globalThis, "fetch");
    // Default: mkdir and writeFile succeed
    mockedFs.mkdir.mockResolvedValue(undefined);
    mockedFs.writeFile.mockResolvedValue(undefined);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    fetchSpy.mockRestore();
    vi.restoreAllMocks();
  });

  describe("no authToken", () => {
    it("returns undefined immediately without making any fetch", async () => {
      const result = await fetchOrgPolicy(undefined);

      expect(result).toBeUndefined();
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("API success", () => {
    it("returns fetched policy and writes cache", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(samplePolicy), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const result = await fetchOrgPolicy("test-token");

      expect(result).toEqual(samplePolicy);
      expect(mockedFs.writeFile).toHaveBeenCalled();
    });
  });

  describe("API failure with cache fallback", () => {
    it("returns cached policy when cache is within TTL", async () => {
      fetchSpy.mockRejectedValueOnce(new Error("Network error"));

      const cacheEnvelope = JSON.stringify({
        fetchedAt: Date.now() - 60_000, // 1 minute ago — within 5 min TTL
        data: samplePolicy,
      });
      mockedFs.readFile.mockResolvedValueOnce(cacheEnvelope);

      const result = await fetchOrgPolicy("test-token");

      expect(result).toEqual(samplePolicy);
    });

    it("returns undefined when cache is expired", async () => {
      fetchSpy.mockRejectedValueOnce(new Error("Network error"));

      const cacheEnvelope = JSON.stringify({
        fetchedAt: Date.now() - 600_000, // 10 minutes ago — past 5 min TTL
        data: samplePolicy,
      });
      mockedFs.readFile.mockResolvedValueOnce(cacheEnvelope);

      const result = await fetchOrgPolicy("test-token");

      expect(result).toBeUndefined();
    });

    it("returns undefined when no cache file exists", async () => {
      fetchSpy.mockRejectedValueOnce(new Error("Network error"));

      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      mockedFs.readFile.mockRejectedValueOnce(err);

      const result = await fetchOrgPolicy("test-token");

      expect(result).toBeUndefined();
    });
  });

  describe("API non-OK response", () => {
    it("falls back to cache on HTTP 500", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response("Internal Server Error", { status: 500 }),
      );

      const cacheEnvelope = JSON.stringify({
        fetchedAt: Date.now() - 30_000,
        data: samplePolicy,
      });
      mockedFs.readFile.mockResolvedValueOnce(cacheEnvelope);

      const result = await fetchOrgPolicy("test-token");

      expect(result).toEqual(samplePolicy);
    });
  });
});

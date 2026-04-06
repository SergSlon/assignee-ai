/**
 * Tests for CloudFormationSchemaService.
 *
 * @see Story 31.1
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  CloudFormationSchemaService,
  SchemaFetchError,
} from "./cloudformation-schema-service.js";

// ---------- Mock @aws-sdk/client-cloudformation ----------
//
// NOTE: Use plain class/function (not vi.fn) for the constructor mocks because
// vitest's mockReset:true would otherwise wipe their implementations between
// tests, leaving `new CloudFormationClient()` returning an object without a
// `send` method. The hoisted `mockSend` vi.fn keeps stable identity so each
// test can attach `mockResolvedValueOnce`/`mockRejectedValueOnce`.

const mockSend = vi.fn();

vi.mock("@aws-sdk/client-cloudformation", () => {
  class CloudFormationClient {
    send = mockSend;
  }
  function DescribeTypeCommand(input: unknown) {
    return input;
  }
  return {
    CloudFormationClient,
    DescribeTypeCommand,
  };
});

// ---------- Fixtures ----------

/** Realistic minimal S3 Bucket schema (subset of real DescribeType output) */
const S3_BUCKET_SCHEMA = {
  typeName: "AWS::S3::Bucket",
  description: "The AWS::S3::Bucket resource creates an Amazon S3 bucket.",
  properties: {
    BucketName: {
      type: "string",
      description: "A name for the bucket.",
    },
    VersioningConfiguration: {
      type: "object",
      description: "Enables multiple versions of all objects in this bucket.",
    },
  },
  primaryIdentifier: ["/properties/BucketName"],
  readOnlyProperties: [
    "/properties/Arn",
    "/properties/DomainName",
    "/properties/DualStackDomainName",
    "/properties/RegionalDomainName",
    "/properties/WebsiteURL",
  ],
  additionalProperties: false,
};

// ---------- Helpers ----------

let tmpDir: string;

async function createService(
  overrides?: Partial<{
    cacheTtlMs: number;
    cacheDir: string;
    region: string;
  }>,
): Promise<CloudFormationSchemaService> {
  return new CloudFormationSchemaService({
    cacheDir: tmpDir,
    cacheTtlMs: overrides?.cacheTtlMs ?? 7 * 24 * 60 * 60 * 1000,
    region: overrides?.region ?? "us-east-1",
    ...overrides,
  });
}

// ---------- Tests ----------

describe("CloudFormationSchemaService", () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cfn-schema-test-"));
    mockSend.mockReset();
  });

  afterEach(async () => {
    // Clean up temp dir
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("getSchema — cache miss", () => {
    it("calls DescribeType and caches result on cache miss", async () => {
      mockSend.mockResolvedValueOnce({
        Schema: JSON.stringify(S3_BUCKET_SCHEMA),
      });

      const service = await createService();
      const schema = await service.getSchema("AWS::S3::Bucket");

      expect(schema).toEqual(S3_BUCKET_SCHEMA);
      expect(mockSend).toHaveBeenCalledOnce();
      expect(mockSend).toHaveBeenCalledWith({
        Type: "RESOURCE",
        TypeName: "AWS::S3::Bucket",
      });

      // Verify cache file was written
      const cacheFile = path.join(tmpDir, "AWS__S3__Bucket.json");
      const content = await fs.readFile(cacheFile, "utf-8");
      const entry = JSON.parse(content);
      expect(entry.schema).toEqual(S3_BUCKET_SCHEMA);
      expect(entry.typeName).toBe("AWS::S3::Bucket");
      expect(typeof entry.cachedAt).toBe("number");
    });
  });

  describe("getSchema — cache hit", () => {
    it("returns cached schema without API call when cache is fresh", async () => {
      // Pre-populate cache
      const cacheFile = path.join(tmpDir, "AWS__S3__Bucket.json");
      const entry = {
        schema: S3_BUCKET_SCHEMA,
        cachedAt: Date.now(),
        typeName: "AWS::S3::Bucket",
      };
      await fs.writeFile(cacheFile, JSON.stringify(entry), "utf-8");

      const service = await createService();
      const schema = await service.getSchema("AWS::S3::Bucket");

      expect(schema).toEqual(S3_BUCKET_SCHEMA);
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe("getSchema — expired cache", () => {
    it("fetches fresh schema when cache has expired", async () => {
      // Pre-populate cache with old mtime
      const cacheFile = path.join(tmpDir, "AWS__S3__Bucket.json");
      const entry = {
        schema: { old: true },
        cachedAt: Date.now() - 999999999,
        typeName: "AWS::S3::Bucket",
      };
      await fs.writeFile(cacheFile, JSON.stringify(entry), "utf-8");

      // Set file mtime to the past (older than TTL)
      const oldTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000); // 8 days ago
      await fs.utimes(cacheFile, oldTime, oldTime);

      mockSend.mockResolvedValueOnce({
        Schema: JSON.stringify(S3_BUCKET_SCHEMA),
      });

      const service = await createService();
      const schema = await service.getSchema("AWS::S3::Bucket");

      expect(schema).toEqual(S3_BUCKET_SCHEMA);
      expect(mockSend).toHaveBeenCalledOnce();
    });
  });

  describe("getSchema — TypeNotFoundException", () => {
    it("throws SchemaFetchError when type is not found", async () => {
      const typeNotFoundError = new Error("Type AWS::Fake::Resource not found");
      typeNotFoundError.name = "TypeNotFoundException";
      mockSend.mockRejectedValueOnce(typeNotFoundError);

      const service = await createService();

      await expect(service.getSchema("AWS::Fake::Resource")).rejects.toThrow(
        SchemaFetchError,
      );

      await expect(
        service.getSchema("AWS::Fake::Resource"),
      ).rejects.toMatchObject({
        typeName: "AWS::Fake::Resource",
        code: "SCHEMA_FETCH_ERROR",
      });
    });
  });

  describe("getSchema — throttling retry", () => {
    it("retries once on throttling then succeeds", async () => {
      const throttleError = new Error("Rate exceeded");
      throttleError.name = "Throttling";
      mockSend.mockRejectedValueOnce(throttleError).mockResolvedValueOnce({
        Schema: JSON.stringify(S3_BUCKET_SCHEMA),
      });

      const service = await createService();
      const schema = await service.getSchema("AWS::S3::Bucket");

      expect(schema).toEqual(S3_BUCKET_SCHEMA);
      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it("throws SchemaFetchError after second throttling failure", async () => {
      const throttleError = new Error("Rate exceeded");
      throttleError.name = "Throttling";
      mockSend
        .mockRejectedValueOnce(throttleError)
        .mockRejectedValueOnce(throttleError);

      const service = await createService();

      await expect(service.getSchema("AWS::S3::Bucket")).rejects.toThrow(
        SchemaFetchError,
      );
    });
  });

  describe("getSchema — network error", () => {
    it("throws SchemaFetchError on generic API error", async () => {
      mockSend.mockRejectedValueOnce(new Error("Network timeout"));

      const service = await createService();

      await expect(service.getSchema("AWS::S3::Bucket")).rejects.toThrow(
        SchemaFetchError,
      );
    });
  });

  describe("invalidateCache", () => {
    it("removes a single cache file when typeName is provided", async () => {
      const cacheFile = path.join(tmpDir, "AWS__S3__Bucket.json");
      await fs.writeFile(cacheFile, "{}", "utf-8");

      const service = await createService();
      await service.invalidateCache("AWS::S3::Bucket");

      await expect(fs.stat(cacheFile)).rejects.toThrow();
    });

    it("removes all cache files when no typeName is provided", async () => {
      await fs.writeFile(
        path.join(tmpDir, "AWS__S3__Bucket.json"),
        "{}",
        "utf-8",
      );
      await fs.writeFile(
        path.join(tmpDir, "AWS__EC2__Instance.json"),
        "{}",
        "utf-8",
      );

      const service = await createService();
      await service.invalidateCache();

      const remaining = await fs.readdir(tmpDir);
      expect(remaining).toHaveLength(0);
    });

    it("does not throw when cache file does not exist", async () => {
      const service = await createService();
      await expect(
        service.invalidateCache("AWS::Nonexistent::Type"),
      ).resolves.not.toThrow();
    });

    it("does not throw when cache directory does not exist", async () => {
      const service = new CloudFormationSchemaService({
        cacheDir: path.join(tmpDir, "nonexistent"),
      });
      await expect(service.invalidateCache()).resolves.not.toThrow();
    });
  });
});

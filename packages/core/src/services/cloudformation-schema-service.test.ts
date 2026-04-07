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
import { MissingAssigneeCredentialsError } from "../config/aws-credentials.js";

// ---------- Mock @aws-sdk/client-cloudformation ----------
//
// NOTE: Use plain class/function (not vi.fn) for the constructor mocks because
// vitest's mockReset:true would otherwise wipe their implementations between
// tests, leaving `new CloudFormationClient()` returning an object without a
// `send` method. The hoisted `mockSend` vi.fn keeps stable identity so each
// test can attach `mockResolvedValueOnce`/`mockRejectedValueOnce`.

const mockSend = vi.fn();
// Capture the most recent CloudFormationClient config so the test can
// invoke its credentialDefaultProvider and verify credential resolution.
let lastClientConfig: {
  region?: string;
  credentialDefaultProvider?: () => () => Promise<unknown>;
} | null = null;

vi.mock("@aws-sdk/client-cloudformation", () => {
  class CloudFormationClient {
    send = mockSend;
    constructor(config: {
      region?: string;
      credentialDefaultProvider?: () => () => Promise<unknown>;
    }) {
      lastClientConfig = config;
    }
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

  // ── H7 regression: credentials resolved via the centralized helper ───────
  // The service must NEVER read process.env for ASSIGNEE_READER_* directly
  // and must NEVER fall through to ~/.aws/credentials / SSO / IMDS. The
  // credential provider closure must call `requireAssigneeCredentials("reader")`
  // at request time (not at constructor time), so .env changes during a
  // process lifetime are honored.
  describe("credential resolution (H7 — centralized helper)", () => {
    const ORIGINAL_ENV = { ...process.env };

    beforeEach(() => {
      delete process.env["ASSIGNEE_READER_ACCESS_KEY_ID"];
      delete process.env["ASSIGNEE_READER_SECRET_ACCESS_KEY"];
      // Belt-and-suspenders: shell AWS_* must NOT be honored.
      process.env["AWS_ACCESS_KEY_ID"] = "shell-leak-key";
      process.env["AWS_SECRET_ACCESS_KEY"] = "shell-leak-secret";
      lastClientConfig = null;
    });

    afterEach(() => {
      process.env = { ...ORIGINAL_ENV };
    });

    it("does NOT resolve credentials at constructor time", async () => {
      // Construct the service with reader env unset — this must succeed
      // because credential resolution is deferred to request time.
      const service = await createService();
      expect(service).toBeInstanceOf(CloudFormationSchemaService);
      expect(lastClientConfig).not.toBeNull();
      expect(lastClientConfig!.credentialDefaultProvider).toBeDefined();
    });

    it("credentialDefaultProvider throws MissingAssigneeCredentialsError when reader env unset", async () => {
      await createService();
      const provider = lastClientConfig!.credentialDefaultProvider!();
      await expect(provider()).rejects.toBeInstanceOf(
        MissingAssigneeCredentialsError,
      );
      // Belt-and-suspenders: the error message must name the exact env
      // vars the user needs to set — not a generic SDK error.
      await expect(provider()).rejects.toThrow(/ASSIGNEE_READER_ACCESS_KEY_ID/);
      await expect(provider()).rejects.toThrow(
        /ASSIGNEE_READER_SECRET_ACCESS_KEY/,
      );
    });

    it("credentialDefaultProvider returns real reader creds when env vars are set", async () => {
      await createService();
      const provider = lastClientConfig!.credentialDefaultProvider!();

      // Set reader creds AFTER construction to prove per-request resolution.
      process.env["ASSIGNEE_READER_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
      process.env["ASSIGNEE_READER_SECRET_ACCESS_KEY"] =
        "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

      const creds = (await provider()) as {
        accessKeyId: string;
        secretAccessKey: string;
      };
      expect(creds.accessKeyId).toBe("AKIAIOSFODNN7EXAMPLE");
      expect(creds.secretAccessKey).toBe(
        "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      );
      // Critical: the shell AWS_* values must never be returned.
      expect(creds.accessKeyId).not.toBe("shell-leak-key");
    });

    it("read-at-request-time: constructor → unset reader → set reader → provider returns new values", async () => {
      await createService();
      const provider = lastClientConfig!.credentialDefaultProvider!();

      // First call — reader unset, must throw.
      await expect(provider()).rejects.toBeInstanceOf(
        MissingAssigneeCredentialsError,
      );

      // Now set reader creds.
      process.env["ASSIGNEE_READER_ACCESS_KEY_ID"] = "AKIA1111EXAMPLE";
      process.env["ASSIGNEE_READER_SECRET_ACCESS_KEY"] =
        "secret-abc-DEF-123456789012345678901234567890";

      // Second call through the SAME provider closure returns the new values.
      const creds = (await provider()) as {
        accessKeyId: string;
        secretAccessKey: string;
      };
      expect(creds.accessKeyId).toBe("AKIA1111EXAMPLE");
    });
  });

  // ── M-R6: corrupt cache file must be unlinked, not infinitely re-fetched ─
  // A truncated/partial JSON file in the cache directory previously caused
  // every subsequent getSchema() to (a) read the corrupt file, (b) fail to
  // parse, (c) treat as cache miss and re-fetch from the API, (d) overwrite
  // the cache with the SAME corrupt content if write fails halfway again.
  // This is an unbounded re-fetch loop that hammers DescribeType every call.
  // The fix unlinks the corrupt file inside readCache so the next call sees
  // a clean cache miss + write.
  describe("getSchema — corrupt cache (M-R6)", () => {
    it("unlinks a corrupt cache file and refetches successfully", async () => {
      // Pre-populate cache with truncated JSON (mid-write crash simulation).
      const cacheFile = path.join(tmpDir, "AWS__S3__Bucket.json");
      // Realistic shape — header but truncated body, fresh mtime so it's
      // not pruned for being expired.
      await fs.writeFile(
        cacheFile,
        '{"schema":{"typeName":"AWS::S3::Bucket","prope',
        "utf-8",
      );

      mockSend.mockResolvedValueOnce({
        Schema: JSON.stringify(S3_BUCKET_SCHEMA),
      });

      const service = await createService();
      const schema = await service.getSchema("AWS::S3::Bucket");

      // Re-fetched from the API.
      expect(schema).toEqual(S3_BUCKET_SCHEMA);
      expect(mockSend).toHaveBeenCalledOnce();

      // Cache file MUST exist again (overwritten with valid content) — and
      // critically the new content must parse cleanly. Without the unlink
      // fix, a subsequent read could find the original truncated bytes if
      // the writeCache step failed mid-flight in some edge.
      const newContent = await fs.readFile(cacheFile, "utf-8");
      const parsed = JSON.parse(newContent) as { schema: unknown };
      expect(parsed.schema).toEqual(S3_BUCKET_SCHEMA);
    });

    it("does not re-fetch on every call when the corrupt file is unlinked", async () => {
      // Same scenario, but call getSchema TWICE. After the first call
      // unlinks + rewrites, the second call must hit the cache and NOT
      // call the API again. Without the M-R6 fix, every call would
      // re-fetch indefinitely.
      const cacheFile = path.join(tmpDir, "AWS__S3__Bucket.json");
      await fs.writeFile(cacheFile, "{not json", "utf-8");

      mockSend.mockResolvedValueOnce({
        Schema: JSON.stringify(S3_BUCKET_SCHEMA),
      });

      const service = await createService();
      const first = await service.getSchema("AWS::S3::Bucket");
      const second = await service.getSchema("AWS::S3::Bucket");

      expect(first).toEqual(S3_BUCKET_SCHEMA);
      expect(second).toEqual(S3_BUCKET_SCHEMA);
      // Exactly ONE API call across the two getSchema calls — second was
      // served from the rewritten cache.
      expect(mockSend).toHaveBeenCalledTimes(1);
    });
  });

  // L-A4 regression: cacheFileName must reject type names that don't match
  // /^[A-Za-z0-9:]+$/. Without the guard, a future caller bug (or a malicious
  // upstream config) could pass a value containing path separators or `..`
  // and cause path traversal under the cache directory.
  describe("cacheFileName allowlist guard (L-A4)", () => {
    it("throws on a type name containing path separators", async () => {
      const service = await createService();
      await expect(service.getSchema("../../etc/passwd")).rejects.toThrow(
        /Invalid CloudFormation type name/,
      );
      // No API call must have happened — the validation must fire BEFORE
      // any network or filesystem activity.
      expect(mockSend).not.toHaveBeenCalled();
    });

    it("throws on a type name containing a null byte", async () => {
      const service = await createService();
      await expect(service.getSchema("AWS::S3::Bucket\u0000")).rejects.toThrow(
        /Invalid CloudFormation type name/,
      );
      expect(mockSend).not.toHaveBeenCalled();
    });

    it("throws on an empty type name", async () => {
      const service = await createService();
      await expect(service.getSchema("")).rejects.toThrow(
        /Invalid CloudFormation type name/,
      );
      expect(mockSend).not.toHaveBeenCalled();
    });

    it("accepts valid AWS::Service::Resource type names", async () => {
      mockSend.mockResolvedValueOnce({
        Schema: JSON.stringify(S3_BUCKET_SCHEMA),
      });
      const service = await createService();
      const schema = await service.getSchema("AWS::S3::Bucket");
      expect(schema).toEqual(S3_BUCKET_SCHEMA);
    });
  });
});

import { describe, it, expect, vi } from "vitest";
import {
  DriftDetectorService,
  deepDiff,
  normalizeValue,
} from "./drift-detector.js";
import { DriftStatus, ChangeType } from "@assignee/core";
import {
  ProvisioningErrorKind,
  type ProvisioningPort,
} from "./provisioning-port.js";

/** Helper to create a mock ProvisioningPort */
function createMockPort(
  getResourceImpl: ProvisioningPort["getResource"],
): ProvisioningPort {
  return {
    getResource: getResourceImpl,
    createResource: vi.fn(),
    deleteResource: vi.fn(),
    updateResource: vi.fn(),
    getRequestStatus: vi.fn(),
  };
}

/** Helper to create a CloudControl-style response */
function ccResponse(props: Record<string, unknown>) {
  return {
    ResourceDescription: {
      Properties: JSON.stringify(props),
    },
  };
}

describe("DriftDetectorService", () => {
  describe("checkResource", () => {
    it("returns IN_SYNC when desired and actual states are identical", async () => {
      const desired = {
        BucketName: "my-bucket",
        VersioningConfiguration: { Status: "Enabled" },
      };
      const port = createMockPort(async () => [null, ccResponse(desired)]);
      const service = new DriftDetectorService({ provisioningPort: port });

      const result = await service.checkResource(
        "AWS::S3::Bucket",
        "my-bucket",
        desired,
      );

      expect(result.status).toBe(DriftStatus.IN_SYNC);
      expect(result.driftedFields).toHaveLength(0);
    });

    it("detects single-field drift", async () => {
      const desired = {
        BucketName: "my-bucket",
        VersioningConfiguration: { Status: "Enabled" },
      };
      const actual = {
        BucketName: "my-bucket",
        VersioningConfiguration: { Status: "Suspended" },
      };
      const port = createMockPort(async () => [null, ccResponse(actual)]);
      const service = new DriftDetectorService({ provisioningPort: port });

      const result = await service.checkResource(
        "AWS::S3::Bucket",
        "my-bucket",
        desired,
      );

      expect(result.status).toBe(DriftStatus.DRIFTED);
      expect(result.driftedFields).toHaveLength(1);
      expect(result.driftedFields[0]!.path).toBe(
        "VersioningConfiguration.Status",
      );
      expect(result.driftedFields[0]!.changeType).toBe(ChangeType.MODIFIED);
      expect(result.driftedFields[0]!.desiredValue).toBe("Enabled");
      expect(result.driftedFields[0]!.actualValue).toBe("Suspended");
    });

    it("detects multi-field drift", async () => {
      const desired = {
        BucketName: "my-bucket",
        VersioningConfiguration: { Status: "Enabled" },
        AccelerateConfiguration: { AccelerationStatus: "Enabled" },
      };
      const actual = {
        BucketName: "my-bucket",
        VersioningConfiguration: { Status: "Suspended" },
        AccelerateConfiguration: { AccelerationStatus: "Suspended" },
      };
      const port = createMockPort(async () => [null, ccResponse(actual)]);
      const service = new DriftDetectorService({ provisioningPort: port });

      const result = await service.checkResource(
        "AWS::S3::Bucket",
        "my-bucket",
        desired,
      );

      expect(result.status).toBe(DriftStatus.DRIFTED);
      expect(result.driftedFields.length).toBeGreaterThanOrEqual(2);
    });

    it("returns DELETED when resource is not found", async () => {
      const port = createMockPort(async () => [
        { kind: ProvisioningErrorKind.NOT_FOUND, message: "Not found" },
        null,
      ]);
      const service = new DriftDetectorService({ provisioningPort: port });

      const result = await service.checkResource(
        "AWS::S3::Bucket",
        "deleted-bucket",
        { BucketName: "deleted-bucket" },
      );

      expect(result.status).toBe(DriftStatus.DELETED);
    });

    it("returns ERROR when throttled", async () => {
      const port = createMockPort(async () => [
        { kind: ProvisioningErrorKind.THROTTLED, message: "Rate exceeded" },
        null,
      ]);
      const service = new DriftDetectorService({ provisioningPort: port });

      const result = await service.checkResource(
        "AWS::S3::Bucket",
        "my-bucket",
        { BucketName: "my-bucket" },
      );

      expect(result.status).toBe(DriftStatus.ERROR);
      expect(result.errorMessage).toBe("Rate exceeded");
    });

    it("returns ERROR on access denied", async () => {
      const port = createMockPort(async () => [
        { kind: ProvisioningErrorKind.ACCESS_DENIED, message: "Access denied" },
        null,
      ]);
      const service = new DriftDetectorService({ provisioningPort: port });

      const result = await service.checkResource(
        "AWS::S3::Bucket",
        "my-bucket",
        { BucketName: "my-bucket" },
      );

      expect(result.status).toBe(DriftStatus.ERROR);
      expect(result.errorMessage).toBe("Access denied");
    });

    it("returns BASELINE_MISSING when no desired state is provided", async () => {
      const port = createMockPort(async () => [
        null,
        ccResponse({ BucketName: "orphan" }),
      ]);
      const service = new DriftDetectorService({ provisioningPort: port });

      const result = await service.checkResource(
        "AWS::S3::Bucket",
        "orphan",
        undefined,
      );

      expect(result.status).toBe(DriftStatus.BASELINE_MISSING);
    });

    it("detects nested object drift", async () => {
      const desired = {
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            {
              ServerSideEncryptionByDefault: {
                SSEAlgorithm: "aws:kms",
              },
            },
          ],
        },
      };
      const actual = {
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            {
              ServerSideEncryptionByDefault: {
                SSEAlgorithm: "AES256",
              },
            },
          ],
        },
      };
      const port = createMockPort(async () => [null, ccResponse(actual)]);
      const service = new DriftDetectorService({ provisioningPort: port });

      const result = await service.checkResource(
        "AWS::S3::Bucket",
        "my-bucket",
        desired,
      );

      expect(result.status).toBe(DriftStatus.DRIFTED);
      const sseField = result.driftedFields.find((f) =>
        f.path.includes("SSEAlgorithm"),
      );
      expect(sseField).toBeDefined();
      expect(sseField!.desiredValue).toBe("aws:kms");
      expect(sseField!.actualValue).toBe("AES256");
    });

    it("detects array drift (modified element)", async () => {
      const desired = {
        Tags: [
          { Key: "env", Value: "prod" },
          { Key: "team", Value: "platform" },
        ],
      };
      const actual = {
        Tags: [
          { Key: "env", Value: "staging" },
          { Key: "team", Value: "platform" },
        ],
      };
      const port = createMockPort(async () => [null, ccResponse(actual)]);
      const service = new DriftDetectorService({ provisioningPort: port });

      const result = await service.checkResource(
        "AWS::S3::Bucket",
        "my-bucket",
        desired,
      );

      expect(result.status).toBe(DriftStatus.DRIFTED);
      const tagField = result.driftedFields.find((f) =>
        f.path.includes("Tags[0]"),
      );
      expect(tagField).toBeDefined();
    });

    it("excludes auto-populated fields (Arn differs but is ignored)", async () => {
      const desired = { BucketName: "my-bucket" };
      const actual = {
        BucketName: "my-bucket",
        Arn: "arn:aws:s3:::my-bucket",
      };
      const port = createMockPort(async () => [null, ccResponse(actual)]);
      const service = new DriftDetectorService({ provisioningPort: port });

      const result = await service.checkResource(
        "AWS::S3::Bucket",
        "my-bucket",
        desired,
      );

      expect(result.status).toBe(DriftStatus.IN_SYNC);
    });
  });

  describe("normalizeValue", () => {
    it("converts stringified boolean 'true' to true when desired is boolean", () => {
      expect(normalizeValue("true", true)).toBe(true);
    });

    it("converts stringified boolean 'false' to false when desired is boolean", () => {
      expect(normalizeValue("false", false)).toBe(false);
    });

    it("converts stringified number to number when desired is number", () => {
      expect(normalizeValue("42", 42)).toBe(42);
      expect(normalizeValue("3.14", 3.14)).toBe(3.14);
    });

    it("leaves strings as-is when desired is also a string", () => {
      expect(normalizeValue("hello", "world")).toBe("hello");
    });

    it("treats null/undefined as equivalent", () => {
      expect(normalizeValue(null, undefined)).toBeUndefined();
      expect(normalizeValue(undefined, null)).toBeUndefined();
    });
  });

  describe("checkAll (batch mode — Story 28.6)", () => {
    it("returns one result per entry", async () => {
      const port = createMockPort(async () => [
        null,
        ccResponse({ BucketName: "b" }),
      ]);
      const service = new DriftDetectorService({ provisioningPort: port });

      const results = await service.checkAll([
        {
          typeName: "AWS::S3::Bucket",
          identifier: "b1",
          desiredState: { BucketName: "b" },
        },
        {
          typeName: "AWS::S3::Bucket",
          identifier: "b2",
          desiredState: { BucketName: "b" },
        },
        {
          typeName: "AWS::S3::Bucket",
          identifier: "b3",
          desiredState: { BucketName: "b" },
        },
      ]);

      expect(results).toHaveLength(3);
    });

    it("executes in parallel (faster than sequential)", async () => {
      let concurrent = 0;
      let maxConcurrent = 0;

      const port = createMockPort(async () => {
        concurrent++;
        if (concurrent > maxConcurrent) maxConcurrent = concurrent;
        await new Promise((r) => setTimeout(r, 20));
        concurrent--;
        return [null, ccResponse({ BucketName: "b" })];
      });
      const service = new DriftDetectorService({ provisioningPort: port });

      const entries = Array.from({ length: 6 }, (_, i) => ({
        typeName: "AWS::S3::Bucket",
        identifier: `b${i}`,
        desiredState: { BucketName: "b" },
      }));

      const start = Date.now();
      await service.checkAll(entries, { concurrency: 3 });
      const elapsed = Date.now() - start;

      // With concurrency 3, 6 entries at 20ms each should take ~40ms, not ~120ms
      expect(elapsed).toBeLessThan(100);
      expect(maxConcurrent).toBeLessThanOrEqual(3);
    });

    it("handles partial failure — other resources still checked", async () => {
      let callCount = 0;
      const port = createMockPort(async () => {
        callCount++;
        if (callCount === 2) {
          return [
            {
              kind: ProvisioningErrorKind.SERVICE_ERROR,
              message: "Service error",
            },
            null,
          ];
        }
        return [null, ccResponse({ BucketName: "b" })];
      });
      const service = new DriftDetectorService({ provisioningPort: port });

      const results = await service.checkAll(
        [
          {
            typeName: "AWS::S3::Bucket",
            identifier: "b1",
            desiredState: { BucketName: "b" },
          },
          {
            typeName: "AWS::S3::Bucket",
            identifier: "b2",
            desiredState: { BucketName: "b" },
          },
          {
            typeName: "AWS::S3::Bucket",
            identifier: "b3",
            desiredState: { BucketName: "b" },
          },
        ],
        { concurrency: 1 },
      );

      expect(results).toHaveLength(3);
      const errors = results.filter((r) => r.status === DriftStatus.ERROR);
      expect(errors).toHaveLength(1);
      const successes = results.filter((r) => r.status !== DriftStatus.ERROR);
      expect(successes).toHaveLength(2);
    });

    it("invokes onProgress callback for each resource", async () => {
      const port = createMockPort(async () => [
        null,
        ccResponse({ BucketName: "b" }),
      ]);
      const service = new DriftDetectorService({ provisioningPort: port });
      const progressCalls: number[] = [];

      await service.checkAll(
        [
          {
            typeName: "AWS::S3::Bucket",
            identifier: "b1",
            desiredState: { BucketName: "b" },
          },
          {
            typeName: "AWS::S3::Bucket",
            identifier: "b2",
            desiredState: { BucketName: "b" },
          },
        ],
        {
          concurrency: 1,
          onProgress: (completed, total) => {
            progressCalls.push(completed);
          },
        },
      );

      expect(progressCalls).toEqual([1, 2]);
    });

    it("clamps concurrency to max 50", async () => {
      const port = createMockPort(async () => [
        null,
        ccResponse({ BucketName: "b" }),
      ]);
      const service = new DriftDetectorService({ provisioningPort: port });

      // Should not throw with concurrency > 50 — it clamps
      const results = await service.checkAll(
        [
          {
            typeName: "AWS::S3::Bucket",
            identifier: "b1",
            desiredState: { BucketName: "b" },
          },
        ],
        { concurrency: 100 },
      );
      expect(results).toHaveLength(1);
    });
  });

  describe("deepDiff", () => {
    it("returns empty array for identical objects", () => {
      const obj = { a: 1, b: "two", c: { d: true } };
      expect(deepDiff(obj, obj, "AWS::S3::Bucket")).toHaveLength(0);
    });

    it("detects ADDED_EXTERNALLY fields", () => {
      const desired = { a: 1 };
      const actual = { a: 1, b: 2 };
      const diffs = deepDiff(desired, actual, "AWS::S3::Bucket");
      expect(diffs).toHaveLength(1);
      expect(diffs[0]!.changeType).toBe(ChangeType.ADDED_EXTERNALLY);
      expect(diffs[0]!.path).toBe("b");
    });

    it("detects REMOVED fields", () => {
      const desired = { a: 1, b: 2 };
      const actual = { a: 1 };
      const diffs = deepDiff(desired, actual, "AWS::S3::Bucket");
      expect(diffs).toHaveLength(1);
      expect(diffs[0]!.changeType).toBe(ChangeType.REMOVED);
      expect(diffs[0]!.path).toBe("b");
    });

    it("handles type normalization in diff (stringified boolean matches actual boolean)", () => {
      const desired = { Enabled: true };
      const actual = { Enabled: "true" };
      const diffs = deepDiff(desired, actual, "AWS::S3::Bucket");
      expect(diffs).toHaveLength(0);
    });
  });
});

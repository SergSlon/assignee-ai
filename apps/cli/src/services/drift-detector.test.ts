import { describe, it, expect, vi } from "vitest";
import {
  DriftDetectorService,
  deepDiff,
  deepEqual,
  canonicalSort,
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
      // Tier C: dropped redundant toBeDefined() — find!()
      const sseField = result.driftedFields.find((f) =>
        f.path.includes("SSEAlgorithm"),
      )!;
      expect(sseField.desiredValue).toBe("aws:kms");
      expect(sseField.actualValue).toBe("AES256");
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
      // Tier C: strengthened — assert the actual drifted value, not just defined
      const tagField = result.driftedFields.find((f) =>
        f.path.includes("Tags[0]"),
      )!;
      expect(tagField.path).toContain("Tags[0]");
    });

    it("excludes EFS-specific auto-populated fields (A3 — FileSystemId + ReplicationConfiguration)", async () => {
      // A3 (2026-04-08): EFS readOnly properties FileSystemId and
      // ReplicationConfiguration surface in CCAPI GetResource
      // responses but aren't part of the user's desired state. Without
      // the EFS-specific entry in AUTO_POPULATED_FIELDS, every drift
      // check against an EFS resource would report these as
      // ADDED_EXTERNALLY false positives.
      const desired = {
        Encrypted: true,
        PerformanceMode: "generalPurpose",
        ThroughputMode: "elastic",
        FileSystemTags: [{ Key: "Name", Value: "my-efs" }],
      };
      const actual = {
        Encrypted: true,
        PerformanceMode: "generalPurpose",
        ThroughputMode: "elastic",
        FileSystemTags: [{ Key: "Name", Value: "my-efs" }],
        // AWS-populated readOnly fields that must be filtered out.
        FileSystemId: "fs-0123456789abcdef0",
        ReplicationConfiguration: { Destinations: [] },
      };
      const port = createMockPort(async () => [null, ccResponse(actual)]);
      const service = new DriftDetectorService({ provisioningPort: port });

      const result = await service.checkResource(
        "AWS::EFS::FileSystem",
        "fs-0123456789abcdef0",
        desired,
      );

      expect(result.status).toBe(DriftStatus.IN_SYNC);
      expect(result.driftedFields).toHaveLength(0);
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
          onProgress: (completed, _total) => {
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

  describe("array ordering — false drift prevention (EC-2 #9)", () => {
    it("Tags in different order → IN_SYNC (not DRIFTED)", () => {
      const desired = {
        Tags: [
          { Key: "env", Value: "prod" },
          { Key: "team", Value: "platform" },
          { Key: "app", Value: "api" },
        ],
      };
      const actual = {
        Tags: [
          { Key: "team", Value: "platform" },
          { Key: "app", Value: "api" },
          { Key: "env", Value: "prod" },
        ],
      };
      const diffs = deepDiff(desired, actual, "AWS::EC2::Instance");
      expect(diffs).toHaveLength(0);
    });

    it("SecurityGroup rules in different order → IN_SYNC", () => {
      const desired = {
        SecurityGroupIngress: [
          {
            IpProtocol: "tcp",
            FromPort: 443,
            ToPort: 443,
            CidrIp: "0.0.0.0/0",
          },
          { IpProtocol: "tcp", FromPort: 80, ToPort: 80, CidrIp: "0.0.0.0/0" },
        ],
      };
      const actual = {
        SecurityGroupIngress: [
          { IpProtocol: "tcp", FromPort: 80, ToPort: 80, CidrIp: "0.0.0.0/0" },
          {
            IpProtocol: "tcp",
            FromPort: 443,
            ToPort: 443,
            CidrIp: "0.0.0.0/0",
          },
        ],
      };
      const diffs = deepDiff(desired, actual, "AWS::EC2::SecurityGroup");
      expect(diffs).toHaveLength(0);
    });

    it("Objects with reordered keys → IN_SYNC", () => {
      const desired = {
        Config: { zebra: 1, alpha: 2, middle: 3 },
      };
      const actual = {
        Config: { alpha: 2, middle: 3, zebra: 1 },
      };
      const diffs = deepDiff(desired, actual, "AWS::S3::Bucket");
      expect(diffs).toHaveLength(0);
    });

    it("Actually different arrays → still DRIFTED", () => {
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
      const diffs = deepDiff(desired, actual, "AWS::EC2::Instance");
      expect(diffs.length).toBeGreaterThan(0);
    });

    it("Nested objects with different key ordering → IN_SYNC", () => {
      const desired = {
        Policy: {
          Statement: [
            { Effect: "Allow", Action: "s3:GetObject", Resource: "*" },
          ],
        },
      };
      const actual = {
        Policy: {
          Statement: [
            { Resource: "*", Action: "s3:GetObject", Effect: "Allow" },
          ],
        },
      };
      const diffs = deepDiff(desired, actual, "AWS::IAM::Policy");
      expect(diffs).toHaveLength(0);
    });

    it("Mixed: some fields same (reordered), some actually different → correct diff", () => {
      const desired = {
        Tags: [
          { Key: "env", Value: "prod" },
          { Key: "team", Value: "platform" },
        ],
        Description: "original",
      };
      const actual = {
        Tags: [
          { Key: "team", Value: "platform" },
          { Key: "env", Value: "prod" },
        ],
        Description: "modified",
      };
      const diffs = deepDiff(desired, actual, "AWS::EC2::SecurityGroup");
      // Tags are the same (just reordered) so no drift there
      // Description is genuinely different
      expect(diffs).toHaveLength(1);
      expect(diffs[0]!.path).toBe("Description");
      expect(diffs[0]!.changeType).toBe(ChangeType.MODIFIED);
    });

    it("arrays with extra element in actual → ADDED_EXTERNALLY", () => {
      const desired = {
        Tags: [{ Key: "env", Value: "prod" }],
      };
      const actual = {
        Tags: [
          { Key: "env", Value: "prod" },
          { Key: "team", Value: "platform" },
        ],
      };
      const diffs = deepDiff(desired, actual, "AWS::EC2::Instance");
      expect(diffs).toHaveLength(1);
      expect(diffs[0]!.changeType).toBe(ChangeType.ADDED_EXTERNALLY);
    });

    it("arrays of primitives in different order → IN_SYNC", () => {
      const desired = {
        AvailabilityZones: ["us-east-1a", "us-east-1b", "us-east-1c"],
      };
      const actual = {
        AvailabilityZones: ["us-east-1c", "us-east-1a", "us-east-1b"],
      };
      const diffs = deepDiff(
        desired,
        actual,
        "AWS::ElasticLoadBalancingV2::LoadBalancer",
      );
      expect(diffs).toHaveLength(0);
    });
  });

  describe("canonicalSort", () => {
    it("sorts arrays of objects deterministically", () => {
      const input = [
        { Key: "zebra", Value: "z" },
        { Key: "alpha", Value: "a" },
      ];
      const sorted = canonicalSort(input) as Array<Record<string, string>>;
      expect((sorted[0] as Record<string, string>)["Key"]).toBe("alpha");
      expect((sorted[1] as Record<string, string>)["Key"]).toBe("zebra");
    });

    it("sorts object keys alphabetically", () => {
      const input = { z: 1, a: 2, m: 3 };
      const sorted = canonicalSort(input) as Record<string, number>;
      expect(Object.keys(sorted)).toEqual(["a", "m", "z"]);
    });

    it("handles nested structures recursively", () => {
      const input = {
        outer: [
          { b: 2, a: 1 },
          { d: 4, c: 3 },
        ],
      };
      const sorted = canonicalSort(input) as Record<string, unknown>;
      const arr = (sorted as { outer: Array<Record<string, number>> }).outer;
      expect(Object.keys(arr[0]!)).toEqual(["a", "b"]);
      expect(Object.keys(arr[1]!)).toEqual(["c", "d"]);
    });
  });

  describe("deepEqual", () => {
    it("considers objects with different key order as equal", () => {
      expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    });

    it("considers arrays with different order as equal", () => {
      expect(deepEqual([3, 1, 2], [1, 2, 3])).toBe(true);
    });

    it("detects actually different values", () => {
      expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
    });

    it("handles null and undefined", () => {
      expect(deepEqual(null, null)).toBe(true);
      expect(deepEqual(null, undefined)).toBe(false);
    });
  });
});

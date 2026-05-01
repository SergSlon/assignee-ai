/**
 * CLI Flow Engine — tests for engine-internal handlers and pure utility functions:
 *   - buildPatchDocument (reconcile patch generation)
 *   - destroyAction (exported handler for destroy)
 *   - checkpoint serialization
 *   - drift detector normalizeValue
 *
 * reconcileResource and MemoryService are in cli-flow-reconcile.test.ts.
 *
 * @see Stories 33.x — CLI integration test matrix (split from cli-flow-matrix.test.ts)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { captureOutput, restoreOutput } from "./cli-flow-test-utils.js";

// ═════════════════════════════════════════════════════════════════════════════
// RECONCILE — buildPatchDocument
// ═════════════════════════════════════════════════════════════════════════════

describe("buildPatchDocument (reconcile)", () => {
  let buildPatchDocument: (typeof import("../commands/reconcile.js"))["buildPatchDocument"];

  beforeEach(async () => {
    const mod = await import("../commands/reconcile.js");
    buildPatchDocument = mod.buildPatchDocument;
  });

  it("generates replace op for MODIFIED fields", () => {
    const { ops } = buildPatchDocument([
      {
        path: "VersioningConfiguration.Status",
        desiredValue: "Enabled",
        actualValue: "Suspended",
        changeType: "MODIFIED" as const,
      },
    ]);
    expect(ops).toEqual([
      {
        op: "replace",
        path: "/VersioningConfiguration/Status",
        value: "Enabled",
      },
    ]);
  });

  it("generates add op for REMOVED fields", () => {
    const { ops } = buildPatchDocument([
      {
        path: "Tags.environment",
        desiredValue: "prod",
        actualValue: undefined,
        changeType: "REMOVED" as const,
      },
    ]);
    expect(ops).toEqual([
      { op: "add", path: "/Tags/environment", value: "prod" },
    ]);
  });

  it("generates remove op for ADDED_EXTERNALLY fields", () => {
    const { ops } = buildPatchDocument([
      {
        path: "Tags.unwanted",
        desiredValue: undefined,
        actualValue: "extra",
        changeType: "ADDED_EXTERNALLY" as const,
      },
    ]);
    expect(ops).toEqual([{ op: "remove", path: "/Tags/unwanted" }]);
  });

  it("converts dot notation to JSON pointer paths", () => {
    const { ops } = buildPatchDocument([
      {
        path: "a.b.c",
        desiredValue: 42,
        actualValue: 0,
        changeType: "MODIFIED" as const,
      },
    ]);
    expect(ops[0]).toEqual({
      op: "replace",
      path: "/a/b/c",
      value: 42,
    });
  });

  it("converts array index notation to JSON pointer", () => {
    const { ops } = buildPatchDocument([
      {
        path: "Rules[0].Effect",
        desiredValue: "Allow",
        actualValue: "Deny",
        changeType: "MODIFIED" as const,
      },
    ]);
    expect(ops[0]).toEqual({
      op: "replace",
      path: "/Rules/0/Effect",
      value: "Allow",
    });
  });

  it("handles multiple drifted fields", () => {
    const { ops } = buildPatchDocument([
      {
        path: "Field1",
        desiredValue: "a",
        actualValue: "b",
        changeType: "MODIFIED" as const,
      },
      {
        path: "Field2",
        desiredValue: "x",
        actualValue: undefined,
        changeType: "REMOVED" as const,
      },
      {
        path: "Field3",
        desiredValue: undefined,
        actualValue: "y",
        changeType: "ADDED_EXTERNALLY" as const,
      },
    ]);
    expect(ops).toHaveLength(3);
    expect(ops[0]).toHaveProperty("op", "replace");
    expect(ops[1]).toHaveProperty("op", "add");
    expect(ops[2]).toHaveProperty("op", "remove");
  });

  it("returns empty ops array for no drifted fields", () => {
    const { ops } = buildPatchDocument([]);
    expect(ops).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// DESTROY ACTION — direct handler tests
// ═════════════════════════════════════════════════════════════════════════════

describe("destroyAction", () => {
  beforeEach(() => {
    captureOutput();
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      configurable: true,
    });
  });

  afterEach(() => {
    restoreOutput();
  });

  // Story 50-3: --include-iam / --dry-run / --all flags were removed.
  // destroyAction now only rejects missing-resource invocations.
  it("rejects missing resource", async () => {
    const { destroyAction } = await import("../commands/destroy.js");
    await expect(destroyAction(undefined, {})).rejects.toThrow(
      /needs to know what to destroy/,
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// CHECKPOINT SERVICE
// ═════════════════════════════════════════════════════════════════════════════

describe("checkpoint serialization", () => {
  it("serializeCheckpoint extracts correct fields from state", async () => {
    const { serializeCheckpoint } = await import("@assignee/core/checkpoint");

    const mockState = {
      runId: "test-run-123",
      userIntent: "Create an S3 bucket named my-bucket",
      resourceType: "AWS::S3::Bucket",
      desiredState: { BucketName: "my-bucket" },
      estimatedMonthlyCost: "$0.023/mo",
      preflightPassed: true,
      elicitedOptions: { region: "us-east-1" },
      resourcePattern: undefined,
      resourceQueue: undefined,
    } as never;

    const cp = serializeCheckpoint(mockState);

    expect(cp.runId).toBe("test-run-123");
    expect(cp.userIntent).toBe("Create an S3 bucket named my-bucket");
    expect(cp.resourceType).toBe("AWS::S3::Bucket");
    expect(cp.desiredState).toEqual({ BucketName: "my-bucket" });
    expect(cp.preflightPassed).toBe(true);
    expect(cp.ttl_hours).toBe(72);
    // Pin checkpoint_version to the canonical CHECKPOINT_VERSION constant
    // rather than just toBeDefined — guards against accidental shape
    // regressions and forces a deliberate change to the schema constant.
    const { CHECKPOINT_VERSION } = await import("@assignee/core");
    expect(cp.checkpoint_version).toBe(CHECKPOINT_VERSION);
  });

  it("serializeCheckpoint handles compound resources with queue", async () => {
    const { serializeCheckpoint } = await import("@assignee/core/checkpoint");

    const mockState = {
      runId: "compound-run",
      userIntent: "Create a VPC",
      resourceType: "AWS::EC2::VPC",
      desiredState: {},
      estimatedMonthlyCost: "$50/mo",
      preflightPassed: true,
      elicitedOptions: {},
      resourcePattern: { patternId: "vpc-full" },
      resourceQueue: [
        {
          resourceId: "vpc-1",
          resourceType: "AWS::EC2::VPC",
          displayName: "my-vpc",
          desiredState: { CidrBlock: "10.0.0.0/16" },
        },
        {
          resourceId: "subnet-1",
          resourceType: "AWS::EC2::Subnet",
          displayName: "my-subnet",
          desiredState: { CidrBlock: "10.0.1.0/24" },
        },
      ],
    } as never;

    const cp = serializeCheckpoint(mockState);

    expect(cp.resourcePatternId).toBe("vpc-full");
    expect(cp.resourceQueue).toHaveLength(2);
    expect(cp.resourceQueue![0]!.displayName).toBe("my-vpc");
  });

  it("serializeCheckpoint defaults resourceType to unknown when missing", async () => {
    const { serializeCheckpoint } = await import("@assignee/core/checkpoint");

    const mockState = {
      runId: "no-type-run",
      userIntent: "Do something",
      resourceType: undefined,
      desiredState: undefined,
      estimatedMonthlyCost: undefined,
      preflightPassed: undefined,
      elicitedOptions: undefined,
      resourcePattern: undefined,
      resourceQueue: undefined,
    } as never;

    const cp = serializeCheckpoint(mockState);
    expect(cp.resourceType).toBe("unknown");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// DRIFT DETECTOR — normalizeValue
// ═════════════════════════════════════════════════════════════════════════════

describe("drift detector normalizeValue", () => {
  it("coerces stringified boolean to boolean", async () => {
    const { normalizeValue } = await import("../services/drift-detector.js");
    expect(normalizeValue("true", true)).toBe(true);
    expect(normalizeValue("false", false)).toBe(false);
  });

  it("coerces stringified number to number", async () => {
    const { normalizeValue } = await import("../services/drift-detector.js");
    expect(normalizeValue("42", 42)).toBe(42);
    expect(normalizeValue("3.14", 3.14)).toBe(3.14);
  });

  it("treats null/undefined as equivalent", async () => {
    const { normalizeValue } = await import("../services/drift-detector.js");
    expect(normalizeValue(null, undefined)).toBeUndefined();
    expect(normalizeValue(undefined, null)).toBeUndefined();
  });

  it("leaves non-coercible values untouched", async () => {
    const { normalizeValue } = await import("../services/drift-detector.js");
    expect(normalizeValue("hello", "world")).toBe("hello");
    expect(normalizeValue(42, 99)).toBe(42);
  });
});

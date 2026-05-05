/**
 * Tests for MemoryService (Story 19.3).
 * Uses os.tmpdir() + unique subdirectory for test isolation.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type MockInstance,
} from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { MemoryService } from "./memory.js";
import type {
  ProvisionRecord,
  PatternRecord,
  FailureRecord,
} from "../schema/memory.js";

function makeProvision(
  overrides: Partial<ProvisionRecord> = {},
): ProvisionRecord {
  return {
    runId: "550e8400-e29b-41d4-a716-446655440000",
    resourceType: "AWS::S3::Bucket",
    resourceArn: "arn:aws:s3:::my-bucket",
    region: "us-east-1",
    desiredStateHash: "abc123",
    estimatedMonthlyCost: "$0.023/GB-month",
    timestamp: "2026-03-22T10:00:00.000Z",
    ...overrides,
  };
}

let tmpDir: string;
let service: MemoryService;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "assignee-memory-test-"));
  service = new MemoryService(tmpDir);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("MemoryService — provisions", () => {
  it("appendProvision creates directory and file on first write", async () => {
    // Use a nested dir that doesn't exist yet
    const nestedDir = path.join(tmpDir, "nested", "deep");
    const nestedService = new MemoryService(nestedDir);

    await nestedService.appendProvision(makeProvision());

    const filePath = path.join(nestedDir, "provisions.json");
    const stat = await fs.stat(filePath);
    expect(stat.isFile()).toBe(true);

    const content = JSON.parse(await fs.readFile(filePath, "utf-8"));
    expect(content).toHaveLength(1);
    expect(content[0].resourceType).toBe("AWS::S3::Bucket");
  });

  it("appendProvision accumulates records (not overwriting)", async () => {
    await service.appendProvision(
      makeProvision({ resourceType: "AWS::S3::Bucket" }),
    );

    const after1 = await service.readProvisions();
    expect(after1).toHaveLength(1);

    await service.appendProvision(
      makeProvision({
        runId: "660e8400-e29b-41d4-a716-446655440000",
        resourceType: "AWS::Lambda::Function",
      }),
    );

    const records = await service.readProvisions();
    expect(records).toHaveLength(2);
    expect(records[0]!.resourceType).toBe("AWS::S3::Bucket");
    expect(records[1]!.resourceType).toBe("AWS::Lambda::Function");
  });

  it("readProvisions returns empty array when file is missing", async () => {
    const records = await service.readProvisions();
    expect(records).toEqual([]);
  });

  it("readProvisions returns empty array when file has invalid JSON", async () => {
    await fs.writeFile(
      path.join(tmpDir, "provisions.json"),
      "not valid json {{{",
      "utf-8",
    );

    const records = await service.readProvisions();
    expect(records).toEqual([]);
  });

  it("readProvisions returns empty array when file has invalid schema", async () => {
    await fs.writeFile(
      path.join(tmpDir, "provisions.json"),
      JSON.stringify([{ bad: "data" }]),
      "utf-8",
    );

    const records = await service.readProvisions();
    expect(records).toEqual([]);
  });

  it("readProvisions returns records that can be filtered by resource type", async () => {
    const s3Record = makeProvision({
      resourceType: "AWS::S3::Bucket",
    });
    const lambdaRecord = makeProvision({
      runId: "660e8400-e29b-41d4-a716-446655440000",
      resourceType: "AWS::Lambda::Function",
    });

    await service.appendProvision(s3Record);
    await service.appendProvision(lambdaRecord);

    const all = await service.readProvisions();
    const s3Only = all.filter((r) => r.resourceType === "AWS::S3::Bucket");

    expect(s3Only).toHaveLength(1);
    expect(s3Only[0]!.runId).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  it("constructor accepts custom dir for test isolation", () => {
    const customService = new MemoryService("/tmp/custom-test-dir");
    // Verify it instantiates without error — the dir doesn't need to exist until write
    expect(customService).toBeInstanceOf(MemoryService);
  });
});

// --- SSH-bundle Story iv: readProvisionRecord helper ---

describe("MemoryService — readProvisionRecord (Story iv)", () => {
  const RUN_ID_A = "550e8400-e29b-41d4-a716-446655440000";
  const RUN_ID_B = "660e8400-e29b-41d4-a716-446655440000";
  const ARN_EC2 =
    "arn:aws:ec2:us-east-1:123456789012:instance/i-0abc123def4567890";
  const ARN_S3 = "arn:aws:s3:::my-static-site-1714867200";
  const ARN_GOVCLOUD =
    "arn:aws-us-gov:ec2:us-gov-west-1:123456789012:instance/i-0fedcba987654321f";

  it("returns the matching record by runId", async () => {
    const ec2Record = makeProvision({
      runId: RUN_ID_A,
      resourceType: "AWS::EC2::Instance",
      resourceArn: ARN_EC2,
      publicIpAddressAtApply: "54.99.10.5",
    });
    const s3Record = makeProvision({
      runId: RUN_ID_B,
      resourceType: "AWS::S3::Bucket",
      resourceArn: ARN_S3,
    });
    await service.appendProvision(ec2Record);
    await service.appendProvision(s3Record);

    const found = await service.readProvisionRecord(RUN_ID_A);
    expect(found).toBeDefined();
    expect(found?.runId).toBe(RUN_ID_A);
    expect(found?.resourceArn).toBe(ARN_EC2);
    expect(found?.publicIpAddressAtApply).toBe("54.99.10.5");
  });

  it("returns the matching record by full ARN (aws partition)", async () => {
    await service.appendProvision(
      makeProvision({
        runId: RUN_ID_A,
        resourceType: "AWS::EC2::Instance",
        resourceArn: ARN_EC2,
      }),
    );

    const found = await service.readProvisionRecord(ARN_EC2);
    expect(found?.runId).toBe(RUN_ID_A);
    expect(found?.resourceArn).toBe(ARN_EC2);
  });

  it("returns the matching record by ARN in aws-us-gov partition", async () => {
    await service.appendProvision(
      makeProvision({
        runId: RUN_ID_B,
        resourceType: "AWS::EC2::Instance",
        resourceArn: ARN_GOVCLOUD,
      }),
    );

    const found = await service.readProvisionRecord(ARN_GOVCLOUD);
    expect(found?.runId).toBe(RUN_ID_B);
  });

  it("returns undefined when no record matches", async () => {
    await service.appendProvision(makeProvision({ runId: RUN_ID_A }));

    const missing = await service.readProvisionRecord(RUN_ID_B);
    expect(missing).toBeUndefined();
  });

  it("returns undefined for empty input", async () => {
    await service.appendProvision(makeProvision({ runId: RUN_ID_A }));

    expect(await service.readProvisionRecord("")).toBeUndefined();
  });

  it("trims whitespace before routing — leading-space copy-paste of an ARN still finds the record", async () => {
    // Reviewer MED #4: copy-pasted ARNs frequently pick up a leading
    // space from the terminal (e.g. `assignee describe  arn:aws:...`
    // → Commander forwards "arn:aws:..." with a stray space when the
    // pasted value contains one). Without the trim, the partition-
    // aware ARN regex would miss " arn:aws:..." and silently route
    // to the runId branch, returning undefined for an otherwise-
    // valid resource. The trim lives at the top of
    // readProvisionRecord, so both ARN and runId variants are
    // covered.
    await service.appendProvision(
      makeProvision({
        runId: RUN_ID_A,
        resourceType: "AWS::EC2::Instance",
        resourceArn: ARN_EC2,
      }),
    );

    // Leading + trailing whitespace — both must be trimmed.
    const found = await service.readProvisionRecord(`  ${ARN_EC2}\n`);
    expect(found).toBeDefined();
    expect(found?.runId).toBe(RUN_ID_A);
    expect(found?.resourceArn).toBe(ARN_EC2);

    // Same trim applies to runId-shaped input.
    const foundByRunId = await service.readProvisionRecord(`\t${RUN_ID_A}  `);
    expect(foundByRunId).toBeDefined();
    expect(foundByRunId?.runId).toBe(RUN_ID_A);

    // Whitespace-only input collapses to empty after trim → undefined.
    expect(await service.readProvisionRecord("   \t\n")).toBeUndefined();
  });

  it("ARN lookup does NOT match by runId substring (exact match only)", async () => {
    // A pathological case: an ARN that contains a runId-like substring.
    // The polymorphism rule says ARN-shaped input only ever filters on
    // resourceArn, so a record whose runId equals the substring must
    // not be returned for the ARN query.
    await service.appendProvision(
      makeProvision({
        runId: RUN_ID_A,
        resourceType: "AWS::S3::Bucket",
        resourceArn: ARN_S3,
      }),
    );

    // ARN query → must filter only on resourceArn.
    expect(await service.readProvisionRecord(ARN_EC2)).toBeUndefined();
  });

  it("backwards-compat: reads pre-Story-iv records (no publicIpAddressAtApply)", async () => {
    // Hand-craft a provision file without the new field — simulates a
    // record written before Story iv landed.
    await fs.mkdir(tmpDir, { recursive: true });
    const legacyRecord = {
      runId: RUN_ID_A,
      resourceType: "AWS::EC2::Instance",
      resourceArn: ARN_EC2,
      region: "us-east-1",
      desiredStateHash: "abc123",
      estimatedMonthlyCost: "$8.30/mo",
      timestamp: "2026-03-01T10:00:00.000Z",
      // NO publicIpAddressAtApply field
    };
    await fs.writeFile(
      path.join(tmpDir, "provisions.json"),
      JSON.stringify([legacyRecord]),
      "utf-8",
    );

    const found = await service.readProvisionRecord(RUN_ID_A);
    expect(found).toBeDefined();
    expect(found?.publicIpAddressAtApply).toBeUndefined();
  });
});

// --- Story 19.4: Failure log tests ---

function makeFailure(overrides: Partial<FailureRecord> = {}): FailureRecord {
  return {
    runId: "550e8400-e29b-41d4-a716-446655440000",
    resourceType: "AWS::S3::Bucket",
    errorCode: "AlreadyExists",
    errorMessage: "Bucket already exists",
    suggestedFix: "Try a different name.",
    timestamp: "2026-03-22T10:00:00.000Z",
    ...overrides,
  };
}

describe("MemoryService — failures", () => {
  it("appendFailure creates directory and file on first write", async () => {
    const nestedDir = path.join(tmpDir, "sub", "deep");
    const nestedService = new MemoryService(nestedDir);
    const record = makeFailure();

    await nestedService.appendFailure(record);

    const filePath = path.join(nestedDir, "failures.json");
    const content = JSON.parse(await fs.readFile(filePath, "utf-8"));
    expect(content).toHaveLength(1);
    expect(content[0].errorCode).toBe("AlreadyExists");
  });

  it("appendFailure accumulates records (append-only)", async () => {
    const r1 = makeFailure({ errorCode: "AlreadyExists" });
    const r2 = makeFailure({
      runId: "660e8400-e29b-41d4-a716-446655440000",
      errorCode: "Throttled",
    });

    await service.appendFailure(r1);
    await service.appendFailure(r2);

    const records = await service.readFailures();
    expect(records).toHaveLength(2);
    expect(records[0]!.errorCode).toBe("AlreadyExists");
    expect(records[1]!.errorCode).toBe("Throttled");
  });

  it("readFailures returns empty array when file is missing", async () => {
    const records = await service.readFailures();
    expect(records).toEqual([]);
  });

  it("readFailures returns empty array when file has invalid JSON", async () => {
    await fs.writeFile(
      path.join(tmpDir, "failures.json"),
      "not valid json {{{",
      "utf-8",
    );

    const records = await service.readFailures();
    expect(records).toEqual([]);
  });

  it("readFailures returns empty array when file has wrong schema", async () => {
    await fs.writeFile(
      path.join(tmpDir, "failures.json"),
      JSON.stringify([{ invalid: true }]),
      "utf-8",
    );

    const records = await service.readFailures();
    expect(records).toEqual([]);
  });

  it("records include correct errorCode and suggestedFix", async () => {
    const record = makeFailure({
      errorCode: "Throttled",
      suggestedFix: "Wait and retry.",
    });

    await service.appendFailure(record);
    const records = await service.readFailures();

    expect(records).toHaveLength(1);
    expect(records[0]!.errorCode).toBe("Throttled");
    expect(records[0]!.suggestedFix).toBe("Wait and retry.");
  });
});

// ── Story 19.5: Pattern memory tests ──────────────────────────────────────────

function makePattern(overrides: Partial<PatternRecord> = {}): PatternRecord {
  return {
    pattern: "serverless-api",
    optionsSelected: { Runtime: "nodejs20.x", MemorySize: 256 },
    count: 1,
    lastUsed: "2026-03-22T10:00:00.000Z",
    ...overrides,
  };
}

describe("MemoryService — patterns (Story 19.5)", () => {
  it("upsertPattern creates file with count=1 on first write", async () => {
    await service.upsertPattern(makePattern());

    const filePath = path.join(tmpDir, "patterns.json");
    const content = JSON.parse(await fs.readFile(filePath, "utf-8"));
    expect(content).toHaveLength(1);
    expect(content[0].pattern).toBe("serverless-api");
    expect(content[0].count).toBe(1);
  });

  it("upsertPattern increments count on subsequent writes for same pattern", async () => {
    await service.upsertPattern(makePattern());
    await service.upsertPattern(
      makePattern({ lastUsed: "2026-03-23T10:00:00.000Z" }),
    );

    const records = await service.readPatterns();
    expect(records).toHaveLength(1);
    expect(records[0]!.count).toBe(2);
    expect(records[0]!.lastUsed).toBe("2026-03-23T10:00:00.000Z");
  });

  it("upsertPattern updates optionsSelected to latest values", async () => {
    await service.upsertPattern(
      makePattern({ optionsSelected: { Runtime: "nodejs18.x" } }),
    );
    await service.upsertPattern(
      makePattern({
        optionsSelected: { Runtime: "nodejs20.x", MemorySize: 512 },
        lastUsed: "2026-03-23T10:00:00.000Z",
      }),
    );

    const records = await service.readPatterns();
    expect(records[0]!.optionsSelected).toEqual({
      Runtime: "nodejs20.x",
      MemorySize: 512,
    });
  });

  it("upsertPattern creates new entry when pattern key differs", async () => {
    await service.upsertPattern(makePattern({ pattern: "serverless-api" }));
    await service.upsertPattern(makePattern({ pattern: "three-tier-web" }));

    const records = await service.readPatterns();
    expect(records).toHaveLength(2);
    expect(records[0]!.pattern).toBe("serverless-api");
    expect(records[1]!.pattern).toBe("three-tier-web");
  });

  it("upsertPattern idempotency: calling twice results in count=2, not two entries", async () => {
    await service.upsertPattern(makePattern());
    await service.upsertPattern(makePattern());

    const records = await service.readPatterns();
    expect(records).toHaveLength(1);
    expect(records[0]!.count).toBe(2);
  });

  it("readPatterns returns empty array when file is missing", async () => {
    const records = await service.readPatterns();
    expect(records).toEqual([]);
  });

  it("readPatterns returns empty array when file has invalid JSON", async () => {
    await fs.writeFile(
      path.join(tmpDir, "patterns.json"),
      "not valid json {{{",
      "utf-8",
    );

    const records = await service.readPatterns();
    expect(records).toEqual([]);
  });

  it("readPatterns returns empty array when file has invalid schema", async () => {
    await fs.writeFile(
      path.join(tmpDir, "patterns.json"),
      JSON.stringify([{ bad: "data" }]),
      "utf-8",
    );

    const records = await service.readPatterns();
    expect(records).toEqual([]);
  });
});

// ── Story 20.13: clearFailuresForType tests ──────────────────────────────────

describe("MemoryService — clearFailuresForType (Story 20.13)", () => {
  it("removes failures matching the given resource type", async () => {
    await service.appendFailure(
      makeFailure({ resourceType: "AWS::S3::Bucket", errorCode: "A" }),
    );
    await service.appendFailure(
      makeFailure({
        runId: "660e8400-e29b-41d4-a716-446655440000",
        resourceType: "AWS::Lambda::Function",
        errorCode: "B",
      }),
    );

    await service.clearFailuresForType("AWS::S3::Bucket");

    const records = await service.readFailures();
    expect(records).toHaveLength(1);
    expect(records[0]!.resourceType).toBe("AWS::Lambda::Function");
  });

  it("does nothing when no failures match the type", async () => {
    await service.appendFailure(
      makeFailure({ resourceType: "AWS::S3::Bucket" }),
    );

    await service.clearFailuresForType("AWS::Lambda::Function");

    const records = await service.readFailures();
    expect(records).toHaveLength(1);
  });

  it("does nothing when failures file is empty", async () => {
    await service.clearFailuresForType("AWS::S3::Bucket");
    const records = await service.readFailures();
    expect(records).toEqual([]);
  });
});

// ── Rotation tests ────────────────────────────────────────────────────────────

describe("MemoryService — rotateProvisions", () => {
  it("returns 0 when records are within the cap", async () => {
    await service.appendProvision(makeProvision());
    const removed = await service.rotateProvisions(10);
    expect(removed).toBe(0);
  });

  it("trims oldest records to stay within maxRecords", async () => {
    for (let i = 0; i < 5; i++) {
      await service.appendProvision(
        makeProvision({
          runId: `550e8400-e29b-41d4-a716-44665544000${i}`,
          timestamp: `2026-03-${20 + i}T10:00:00.000Z`,
        }),
      );
    }

    const removed = await service.rotateProvisions(3);
    expect(removed).toBe(2);

    const remaining = await service.readProvisions();
    expect(remaining).toHaveLength(3);
  });

  it("respects preserveFilter — never removes preserved records", async () => {
    for (let i = 0; i < 5; i++) {
      await service.appendProvision(
        makeProvision({
          runId: `550e8400-e29b-41d4-a716-44665544000${i}`,
          resourceType: i === 0 ? "AWS::Lambda::Function" : "AWS::S3::Bucket",
          timestamp: `2026-03-${20 + i}T10:00:00.000Z`,
        }),
      );
    }

    const removed = await service.rotateProvisions(
      2,
      (r) => r.resourceType === "AWS::Lambda::Function",
    );

    expect(removed).toBeGreaterThan(0);

    const remaining = await service.readProvisions();
    const lambdas = remaining.filter(
      (r) => r.resourceType === "AWS::Lambda::Function",
    );
    expect(lambdas).toHaveLength(1); // preserved record is kept
  });
});

describe("MemoryService — rotateFailures", () => {
  it("returns 0 when records are within the cap", async () => {
    await service.appendFailure(makeFailure());
    const removed = await service.rotateFailures(10);
    expect(removed).toBe(0);
  });

  it("trims oldest failure records to stay within maxRecords", async () => {
    for (let i = 0; i < 5; i++) {
      await service.appendFailure(
        makeFailure({
          runId: `550e8400-e29b-41d4-a716-44665544000${i}`,
        }),
      );
    }
    const removed = await service.rotateFailures(2);
    expect(removed).toBe(3);

    const remaining = await service.readFailures();
    expect(remaining).toHaveLength(2);
  });
});

describe("MemoryService — rotatePatterns", () => {
  it("returns 0 when records are within the cap", async () => {
    await service.upsertPattern(makePattern());
    const removed = await service.rotatePatterns(10);
    expect(removed).toBe(0);
  });

  it("trims oldest pattern records to stay within maxRecords", async () => {
    for (let i = 0; i < 5; i++) {
      await service.upsertPattern(makePattern({ pattern: `pattern-${i}` }));
    }
    const removed = await service.rotatePatterns(2);
    expect(removed).toBe(3);

    const remaining = await service.readPatterns();
    expect(remaining).toHaveLength(2);
  });
});

// REG-N5: Rotation must acquire the lock BEFORE reading the file. Otherwise
// a concurrent appendProvision/appendFailure/upsertPattern can slip a new
// record in between (read, lock-acquire), and the rotation's atomicWrite
// will clobber it.
describe("MemoryService — rotation TOCTOU (REG-N5)", () => {
  it("rotateProvisions acquires lock BEFORE reading the file", async () => {
    // Seed enough records to trigger rotation.
    for (let i = 0; i < 5; i++) {
      await service.appendProvision(
        makeProvision({
          runId: `550e8400-e29b-41d4-a716-44665544000${i}`,
          timestamp: `2026-03-${20 + i}T10:00:00.000Z`,
        }),
      );
    }

    const callOrder: string[] = [];
    const acquireSpy = vi
      // @ts-expect-error -- private method, accessed for ordering verification
      .spyOn(service as unknown as Record<string, unknown>, "acquireLock")
      .mockImplementation(async function (this: unknown, ...args: unknown[]) {
        callOrder.push("acquireLock");
        // Call through to real implementation.
        // @ts-expect-error -- prototype access
        return MemoryService.prototype["acquireLock"].apply(service, args);
      });
    const readSpy = vi
      .spyOn(service, "readProvisions")
      .mockImplementation(async function (this: MemoryService) {
        callOrder.push("readProvisions");
        // Call through to real implementation via prototype.
        return MemoryService.prototype.readProvisions.call(service);
      });

    try {
      await service.rotateProvisions(3);
    } finally {
      acquireSpy.mockRestore();
      readSpy.mockRestore();
    }

    const acquireIdx = callOrder.indexOf("acquireLock");
    const readIdx = callOrder.indexOf("readProvisions");
    expect(acquireIdx).toBeGreaterThanOrEqual(0);
    expect(readIdx).toBeGreaterThanOrEqual(0);
    expect(acquireIdx).toBeLessThan(readIdx);
  });

  it("rotateFailures acquires lock BEFORE reading the file", async () => {
    for (let i = 0; i < 5; i++) {
      await service.appendFailure(
        makeFailure({
          runId: `550e8400-e29b-41d4-a716-44665544000${i}`,
        }),
      );
    }

    const callOrder: string[] = [];
    const acquireSpy = vi
      // @ts-expect-error -- private method
      .spyOn(service as unknown as Record<string, unknown>, "acquireLock")
      .mockImplementation(async function (this: unknown, ...args: unknown[]) {
        callOrder.push("acquireLock");
        // @ts-expect-error -- prototype access
        return MemoryService.prototype["acquireLock"].apply(service, args);
      });
    const readSpy = vi
      .spyOn(service, "readFailures")
      .mockImplementation(async function (this: MemoryService) {
        callOrder.push("readFailures");
        return MemoryService.prototype.readFailures.call(service);
      });

    try {
      await service.rotateFailures(2);
    } finally {
      acquireSpy.mockRestore();
      readSpy.mockRestore();
    }

    expect(callOrder.indexOf("acquireLock")).toBeLessThan(
      callOrder.indexOf("readFailures"),
    );
  });

  it("rotatePatterns acquires lock BEFORE reading the file", async () => {
    for (let i = 0; i < 5; i++) {
      await service.upsertPattern(makePattern({ pattern: `pattern-${i}` }));
    }

    const callOrder: string[] = [];
    const acquireSpy = vi
      // @ts-expect-error -- private method
      .spyOn(service as unknown as Record<string, unknown>, "acquireLock")
      .mockImplementation(async function (this: unknown, ...args: unknown[]) {
        callOrder.push("acquireLock");
        // @ts-expect-error -- prototype access
        return MemoryService.prototype["acquireLock"].apply(service, args);
      });
    const readSpy = vi
      .spyOn(service, "readPatterns")
      .mockImplementation(async function (this: MemoryService) {
        callOrder.push("readPatterns");
        return MemoryService.prototype.readPatterns.call(service);
      });

    try {
      await service.rotatePatterns(2);
    } finally {
      acquireSpy.mockRestore();
      readSpy.mockRestore();
    }

    expect(callOrder.indexOf("acquireLock")).toBeLessThan(
      callOrder.indexOf("readPatterns"),
    );
  });

  it("concurrent rotateProvisions+appendProvision: no records are lost", async () => {
    // Real-shaped concurrency test. Pre-seed 5 records, then race a rotation
    // (cap=3) against an appendProvision. With the fix the rotation holds the
    // lock for the entire read-trim-write cycle, so either:
    //   (a) rotation wins → 3 trimmed records, append's lock acquire fails
    //       and the new record is dropped (existing acquireLock returns false
    //       which appendProvision logs+skips), OR
    //   (b) append wins → 6 records present, rotation skips lock acquire
    //       and trims none (returns 0).
    // Under the bug (read-before-lock) you could see 4 records (rotation
    // clobbered the appended one). The assertion asserts "no clobbering": we
    // never see a state where the appended record is missing from a 4-record
    // file.
    for (let i = 0; i < 5; i++) {
      await service.appendProvision(
        makeProvision({
          runId: `550e8400-e29b-41d4-a716-44665544000${i}`,
          timestamp: `2026-03-${20 + i}T10:00:00.000Z`,
        }),
      );
    }

    // Slow the rotation's read step so an interleaving append window exists
    // — but with the fix, the lock is already held when the slow read fires,
    // so the append's acquireLock will fail-fast and skip rather than clobber.
    // Yield via microtasks (8 cycles) instead of a 25 ms wall-clock wait —
    // each `await Promise.resolve()` lets the queued append microtask run
    // and attempt its own lock acquisition before rotation proceeds.
    const realRead = MemoryService.prototype.readProvisions;
    const readSpy = vi
      .spyOn(service, "readProvisions")
      .mockImplementation(async function (this: MemoryService) {
        for (let i = 0; i < 8; i++) {
          await Promise.resolve();
        }
        return realRead.call(this);
      });

    // Silence the "could not acquire lock" warning the appendProvision will
    // print when the rotation holds the lock.
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(
        (() => true) as unknown as typeof process.stderr.write,
      );

    const newRecord = makeProvision({
      runId: "550e8400-e29b-41d4-a716-446655440099",
      resourceType: "AWS::Lambda::Function",
      timestamp: "2026-03-30T10:00:00.000Z",
    });

    try {
      await Promise.all([
        service.rotateProvisions(3),
        // Stagger by a microtask so rotation grabs the lock first.
        Promise.resolve().then(() => service.appendProvision(newRecord)),
      ]);
    } finally {
      readSpy.mockRestore();
      stderrSpy.mockRestore();
    }

    const final = await service.readProvisions();
    // Either rotation won (3 records, no Lambda) OR append won (6 records,
    // contains Lambda). The buggy "clobber" path produced ~4 records with no
    // Lambda — assert that never happens.
    const hasLambda = final.some(
      (r) => r.resourceType === "AWS::Lambda::Function",
    );
    if (hasLambda) {
      // Append slipped in BEFORE rotation's lock — rotation must have skipped
      // (lock contention) so file should still have all 6 records.
      expect(final).toHaveLength(6);
    } else {
      // Rotation won — exactly 3 records, no clobbering of an append.
      expect(final).toHaveLength(3);
    }
  });
});

// ── EC-29: Corrupt file backup tests ─────────────────────────────────────────

describe("MemoryService — corrupt file backup (EC-29)", () => {
  let stderrSpy: MockInstance<typeof process.stderr.write>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(
        (() => true) as unknown as typeof process.stderr.write,
      );
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it("backs up corrupt provisions.json before returning empty array", async () => {
    const corruptContent = "not valid json {{{";
    await fs.writeFile(
      path.join(tmpDir, "provisions.json"),
      corruptContent,
      "utf-8",
    );

    const records = await service.readProvisions();
    expect(records).toEqual([]);

    // Verify backup file was created
    const files = await fs.readdir(tmpDir);
    const backupFile = files.find((f) =>
      f.startsWith("provisions.json.corrupt."),
    );
    expect(backupFile).toBeTruthy();

    // Verify backup content matches the corrupt file
    const backupContent = await fs.readFile(
      path.join(tmpDir, backupFile!),
      "utf-8",
    );
    expect(backupContent).toBe(corruptContent);

    // Verify warning was printed
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("provisions.json appears corrupt"),
    );
  });

  it("backs up corrupt failures.json before returning empty array", async () => {
    const corruptContent = '{"truncated": true';
    await fs.writeFile(
      path.join(tmpDir, "failures.json"),
      corruptContent,
      "utf-8",
    );

    const records = await service.readFailures();
    expect(records).toEqual([]);

    const files = await fs.readdir(tmpDir);
    const backupFile = files.find((f) =>
      f.startsWith("failures.json.corrupt."),
    );
    expect(backupFile).toBeTruthy();

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("failures.json appears corrupt"),
    );
  });

  it("backs up corrupt patterns.json before returning empty array", async () => {
    const corruptContent = "[{broken";
    await fs.writeFile(
      path.join(tmpDir, "patterns.json"),
      corruptContent,
      "utf-8",
    );

    const records = await service.readPatterns();
    expect(records).toEqual([]);

    const files = await fs.readdir(tmpDir);
    const backupFile = files.find((f) =>
      f.startsWith("patterns.json.corrupt."),
    );
    expect(backupFile).toBeTruthy();

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("patterns.json appears corrupt"),
    );
  });

  it("does NOT create backup for missing file (returns empty array silently)", async () => {
    const records = await service.readProvisions();
    expect(records).toEqual([]);

    const files = await fs.readdir(tmpDir);
    const backupFiles = files.filter((f) => f.includes(".corrupt."));
    expect(backupFiles).toHaveLength(0);

    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("does NOT create backup for empty file (size === 0)", async () => {
    await fs.writeFile(path.join(tmpDir, "provisions.json"), "", "utf-8");

    const records = await service.readProvisions();
    expect(records).toEqual([]);

    const files = await fs.readdir(tmpDir);
    const backupFiles = files.filter((f) => f.includes(".corrupt."));
    expect(backupFiles).toHaveLength(0);
  });

  it("drops schema-failing records, preserves valid ones, no backup-and-zero", async () => {
    // One stray test fixture (`runId='test-fixture-001'` fails uuid validation)
    // used to nuke the entire array via safeParse rejection. Per-record
    // validation now drops the bad row and keeps the valid one.
    const goodRunId = "9baab789-7ffd-48a0-a6f9-77139a3c18a0";
    await fs.writeFile(
      path.join(tmpDir, "provisions.json"),
      JSON.stringify([
        { bad: "data" },
        {
          runId: goodRunId,
          resourceType: "AWS::S3::Bucket",
          resourceArn: "arn:aws:s3:::test-bucket",
          region: "us-east-1",
          desiredStateHash: "abc123",
          estimatedMonthlyCost: "0.0230",
          timestamp: "2026-05-04T00:00:00.000Z",
        },
      ]),
      "utf-8",
    );

    const records = await service.readProvisions();
    // 1 valid record preserved, the 1 bad row silently dropped
    expect(records).toHaveLength(1);
    expect(records[0]!.runId).toBe(goodRunId);

    // No backup — the JSON parsed fine, only one row failed schema. The
    // old behaviour of backup-and-zero on any-schema-failure caused real
    // user data loss (bug #10) and is gone.
    const files = await fs.readdir(tmpDir);
    expect(
      files.find((f) => f.startsWith("provisions.json.corrupt.")),
    ).toBeUndefined();
  });

  it("still backs up + returns [] when the file is unparseable JSON", async () => {
    await fs.writeFile(
      path.join(tmpDir, "provisions.json"),
      "{not-json{",
      "utf-8",
    );
    const records = await service.readProvisions();
    expect(records).toEqual([]);
    const files = await fs.readdir(tmpDir);
    expect(files.some((f) => f.startsWith("provisions.json.corrupt."))).toBe(
      true,
    );
  });

  it("subsequent append after corruption writes only the new record (not lost data)", async () => {
    await fs.writeFile(
      path.join(tmpDir, "provisions.json"),
      "not valid json {{{",
      "utf-8",
    );

    // Read triggers backup
    await service.readProvisions();

    // Now append a new record
    await service.appendProvision(
      makeProvision({ resourceType: "AWS::Lambda::Function" }),
    );

    const records = await service.readProvisions();
    expect(records).toHaveLength(1);
    expect(records[0]!.resourceType).toBe("AWS::Lambda::Function");

    // Backup still exists for recovery
    const files = await fs.readdir(tmpDir);
    const backupFile = files.find((f) =>
      f.startsWith("provisions.json.corrupt."),
    );
    expect(backupFile).toBeTruthy();
  });
});

// L-A2 regression: memory directory and JSON files must be created with
// 0o700 / 0o600 modes so other local users cannot read provision logs
// (which contain resource ARNs and intent strings).
describe("MemoryService — file permissions (L-A2)", () => {
  it("creates the memory directory with mode 0o700", async () => {
    // Use a fresh nested dir so ensureDir() actually has to mkdir.
    const nestedDir = path.join(tmpDir, "perm-dir-test");
    const nestedService = new MemoryService(nestedDir);
    await nestedService.appendProvision(makeProvision());

    const stat = await fs.stat(nestedDir);
    // Mask off file-type bits and compare permission bits only.
    const mode = stat.mode & 0o777;
    if (process.platform === "win32") {
      // Windows does not enforce POSIX permission bits — skip.
      expect(mode).toBeGreaterThanOrEqual(0);
    } else {
      expect(mode).toBe(0o700);
    }
  });

  it("writes provisions.json with mode 0o600", async () => {
    await service.appendProvision(makeProvision());
    const stat = await fs.stat(path.join(tmpDir, "provisions.json"));
    const mode = stat.mode & 0o777;
    if (process.platform === "win32") {
      expect(mode).toBeGreaterThanOrEqual(0);
    } else {
      expect(mode).toBe(0o600);
    }
  });

  it("writes failures.json with mode 0o600", async () => {
    const failure: FailureRecord = {
      runId: "550e8400-e29b-41d4-a716-446655440000",
      resourceType: "AWS::S3::Bucket",
      errorMessage: "BucketAlreadyExists",
      errorCode: "ALREADY_EXISTS",
      suggestedFix: "Choose a different bucket name",
      timestamp: "2026-03-22T10:00:00.000Z",
    };
    await service.appendFailure(failure);
    const stat = await fs.stat(path.join(tmpDir, "failures.json"));
    const mode = stat.mode & 0o777;
    if (process.platform === "win32") {
      expect(mode).toBeGreaterThanOrEqual(0);
    } else {
      expect(mode).toBe(0o600);
    }
  });
});

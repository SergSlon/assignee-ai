/**
 * Tests for MemoryService (Story 19.3).
 * Uses os.tmpdir() + unique subdirectory for test isolation.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { MemoryService } from "./memory.js";
import type {
  ProvisionRecord,
  PatternRecord,
  FailureRecord,
} from "@assignee/core";

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

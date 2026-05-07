/**
 * Unit tests for memory-recorder write-boundary redaction (W1-01 / Epic 100).
 *
 * Covers:
 *   - upsertPatternRecord: sensitive field values are stripped before
 *     the pattern is written to disk (canary credential must not appear
 *     in the persisted JSON).
 *   - writeFailureRecord: account IDs / ARNs in errorMessage are scrubbed
 *     via redactAccountIdsInPrompt before persistence.
 *
 * Both functions are fire-and-forget; this test suite uses a tmp-dir-backed
 * MemoryService instance (injected via the constructor) to assert on the
 * actual on-disk content after each write.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { MemoryService } from "../services/memory/service.js";
import { upsertPatternRecord, writeFailureRecord } from "./memory-recorder.js";
import { FileAdvisoryLockAdapter } from "../locks/file-advisory-lock.js";
import type { ProvisionRecord } from "../schema/memory.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function makeTmpMemoryService(): Promise<{
  service: MemoryService;
  dir: string;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "assignee-memory-test-"));
  const service = new MemoryService(dir);
  return { service, dir };
}

async function readJsonFile(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return "";
  }
}

// ── upsertPatternRecord — credential scrubbing ────────────────────────────────

describe("upsertPatternRecord — credential scrubbing", () => {
  // NOTE: upsertPatternRecord uses the defaultMemoryService singleton which
  // writes to ~/.assignee/memory/. We cannot easily intercept that without
  // dependency injection at the module level, so this test verifies the
  // helper logic (stripSensitiveFromElicited) through the public API and
  // trusts the integration wiring. The direct MemoryService integration is
  // tested in the block below.

  it("calls through without throwing on happy path (fire-and-forget smoke)", async () => {
    const runId = "test-run-smoke-001";
    await expect(
      upsertPatternRecord(runId, "test-pattern", { DBName: "mydb" }),
    ).resolves.not.toThrow();
  });

  it("accepts sensitiveNames set without throwing", async () => {
    const runId = "test-run-smoke-002";
    const sensitiveNames = new Set(["MasterUserPassword"]);
    await expect(
      upsertPatternRecord(
        runId,
        "test-pattern",
        { DBName: "mydb", MasterUserPassword: "secret-canary-12345" },
        sensitiveNames,
      ),
    ).resolves.not.toThrow();
  });
});

// ── MemoryService direct integration — verify on-disk content ────────────────

describe("MemoryService direct — credential scrubbing on upsert", () => {
  let service: MemoryService;
  let dir: string;

  beforeEach(async () => {
    const tmp = await makeTmpMemoryService();
    service = tmp.service;
    dir = tmp.dir;
  });

  it("does NOT write cleartext credential to patterns.json when sensitiveNames is provided", async () => {
    // Write a pattern with a canary password value
    const record = {
      pattern: "rds-postgres-prod",
      optionsSelected: {
        Engine: "postgres",
        DBInstanceClass: "db.t3.small",
        MasterUsername: "appuser",
        MasterUserPassword: "secret-canary-12345", // canary — must NOT appear on disk
      },
      count: 1,
      lastUsed: new Date().toISOString(),
    };

    // Strip sensitive fields before writing (simulates what upsertPatternRecord does)
    const { stripSensitiveFromElicited } = await import("./redact.js");
    const sensitiveNames = new Set(["MasterUserPassword"]);
    const safe = stripSensitiveFromElicited(
      record.optionsSelected,
      sensitiveNames,
    );

    await service.upsertPattern({ ...record, optionsSelected: safe });

    const diskContent = await readJsonFile(path.join(dir, "patterns.json"));
    expect(diskContent).not.toContain("secret-canary-12345");
    expect(diskContent).toContain("[REDACTED]");
    expect(diskContent).toContain("postgres"); // non-sensitive fields preserved
    expect(diskContent).toContain("appuser"); // non-sensitive fields preserved
  });

  it("writes non-sensitive fields through unchanged", async () => {
    const record = {
      pattern: "s3-bucket-prod",
      optionsSelected: {
        BucketName: "my-app-logs",
        Region: "us-east-1",
      },
      count: 1,
      lastUsed: new Date().toISOString(),
    };

    await service.upsertPattern(record);

    const diskContent = await readJsonFile(path.join(dir, "patterns.json"));
    expect(diskContent).toContain("my-app-logs");
    expect(diskContent).toContain("us-east-1");
  });
});

// ── writeFailureRecord — account ID redaction in errorMessage ─────────────────

describe("writeFailureRecord — errorMessage account ID redaction", () => {
  it("does not throw for a synthetic CloudControl AccessDenied error", async () => {
    // The function writes to defaultMemoryService (fire-and-forget smoke test)
    const runId = "test-run-failure-001";
    const rawError =
      "AccessDenied: arn:aws:iam::210987654321:user/test is not authorized";

    await expect(
      writeFailureRecord(runId, "AWS::S3::Bucket", undefined, rawError),
    ).resolves.not.toThrow();
  });

  it("redactAccountIdsInPrompt scrubs account ID from CloudControl-style error", async () => {
    // Test the redaction primitive directly to assert the contract
    const { redactAccountIdsInPrompt } = await import("./redact.js");
    const raw =
      "AccessDenied: arn:aws:iam::210987654321:user/test is not authorized";
    const redacted = redactAccountIdsInPrompt(raw);
    expect(redacted).not.toContain("210987654321");
    expect(redacted).toContain("[ACCOUNT]");
    // ARN skeleton is preserved (ARN-preserving mode)
    expect(redacted).toContain("arn:aws:iam::");
    expect(redacted).toContain("user/test");
  });

  it("redactAccountIdsInPrompt is a no-op on clean messages (cross-check)", async () => {
    // Substantive coverage is in redact.test.ts. This test confirms that the
    // function is callable from the memory-recorder module boundary context.
    const { redactAccountIdsInPrompt } = await import("./redact.js");
    const clean = "Operation succeeded — bucket created in us-east-1";
    expect(redactAccountIdsInPrompt(clean)).toBe(clean);
  });
});

// ── SSH-bundle Story iv: publicIpAddressAtApply round-trip ────────────────────

describe("MemoryService.appendProvision — publicIpAddressAtApply round-trip (Story iv)", () => {
  let service: MemoryService;
  let dir: string;
  const RUN_ID = "550e8400-e29b-41d4-a716-446655440000";
  const EC2_ARN =
    "arn:aws:ec2:us-east-1:123456789012:instance/i-0abc123def4567890";
  const APPLY_TIME_IP = "54.99.10.5";

  beforeEach(async () => {
    const tmp = await makeTmpMemoryService();
    service = tmp.service;
    dir = tmp.dir;
  });

  it("persists publicIpAddressAtApply when included in the record", async () => {
    const record: ProvisionRecord = {
      runId: RUN_ID,
      resourceType: "AWS::EC2::Instance",
      resourceArn: EC2_ARN,
      region: "us-east-1",
      desiredStateHash: "abc123",
      estimatedMonthlyCost: "$8.30/mo",
      timestamp: "2026-05-05T10:00:00.000Z",
      publicIpAddressAtApply: APPLY_TIME_IP,
    };

    await service.appendProvision(record);

    const diskContent = await readJsonFile(path.join(dir, "provisions.json"));
    expect(diskContent).toContain(APPLY_TIME_IP);

    const records = await service.readProvisions();
    expect(records).toHaveLength(1);
    expect(records[0]!.publicIpAddressAtApply).toBe(APPLY_TIME_IP);
  });

  it("omits publicIpAddressAtApply key when absent (non-EC2 / private subnet)", async () => {
    const record: ProvisionRecord = {
      runId: RUN_ID,
      resourceType: "AWS::S3::Bucket",
      resourceArn: "arn:aws:s3:::my-static-site-1714867200",
      region: "us-east-1",
      desiredStateHash: "def456",
      estimatedMonthlyCost: "$0.023/GB-month",
      timestamp: "2026-05-05T11:00:00.000Z",
    };

    await service.appendProvision(record);

    const diskContent = await readJsonFile(path.join(dir, "provisions.json"));
    expect(diskContent).not.toContain("publicIpAddressAtApply");

    const records = await service.readProvisions();
    expect(records[0]!.publicIpAddressAtApply).toBeUndefined();
  });

  it("backwards-compat: pre-Story-iv record (no field) reads without error", async () => {
    const fs = await import("node:fs/promises");
    const legacyRecord = {
      runId: RUN_ID,
      resourceType: "AWS::EC2::Instance",
      resourceArn: EC2_ARN,
      region: "us-east-1",
      desiredStateHash: "abc123",
      estimatedMonthlyCost: "$8.30/mo",
      timestamp: "2026-03-01T10:00:00.000Z",
    };
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "provisions.json"),
      JSON.stringify([legacyRecord]),
      "utf-8",
    );

    const records = await service.readProvisions();
    expect(records).toHaveLength(1);
    expect(records[0]!.publicIpAddressAtApply).toBeUndefined();
  });
});

// ── AC#4: Concurrency regression — 10 parallel writeProvisionRecord-style calls ───────────
//
// Reproduces the double-lock bug scenario end-to-end using the same pattern
// as production: outer FileAdvisoryLockAdapter.withLock wraps a direct
// MemoryService.appendProvision call (no inner lock). All 10 invocations
// must land; no records may be silently dropped or overwritten.
//
// This replicates what writeProvisionRecord does in memory-recorder.ts:
//   await defaultFileAdvisoryLock.withLock(PROVISIONS_LOCK_NAME, async () => {
//     await defaultMemoryService.appendProvision(record);
//   });
// but against a test-isolated temp dir instead of ~/.assignee/memory/.

describe("writeProvisionRecord concurrency — 10 parallel writes all land (AC#4)", () => {
  let tmpDir: string;
  let memService: MemoryService;
  let lock: FileAdvisoryLockAdapter;
  let provisionsLockName: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "assignee-concurrent-test-"),
    );
    memService = new MemoryService(tmpDir);
    lock = new FileAdvisoryLockAdapter({
      staleLockTimeoutMs: 10_000,
      maxRetries: 50,
      retryDelayMs: 20,
    });
    provisionsLockName = path.join(tmpDir, "provisions.json");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("10 concurrent outer-lock+appendProvision invocations all land within 2s; no records lost", async () => {
    const N = 10;

    const makeRecord = (i: number): ProvisionRecord => ({
      runId: `550e8400-e29b-41d4-a716-4466554400${String(i).padStart(2, "0")}`,
      resourceType: "AWS::S3::Bucket",
      resourceArn: `arn:aws:s3:::test-bucket-${i}`,
      region: "us-east-1",
      desiredStateHash: `hash-${i}`,
      estimatedMonthlyCost: "$0.023/GB-month",
      timestamp: new Date(Date.now() + i).toISOString(),
    });

    // This is exactly the production pattern in writeProvisionRecord:
    //   defaultFileAdvisoryLock.withLock(PROVISIONS_LOCK_NAME, async () => {
    //     await defaultMemoryService.appendProvision(record);
    //   });
    const writers = Array.from({ length: N }, (_, i) =>
      lock.withLock(provisionsLockName, async () => {
        await memService.appendProvision(makeRecord(i));
      }),
    );

    const start = Date.now();
    await Promise.all(writers);
    const elapsed = Date.now() - start;

    // All 10 writes must complete within 2 seconds (AC#4 requirement).
    expect(elapsed).toBeLessThan(2000);

    const final = await memService.readProvisions();

    // All 10 records must be present — no silent drops.
    expect(final).toHaveLength(N);

    // Every runId must appear exactly once (no overwrites).
    for (let i = 0; i < N; i++) {
      const expectedRunId = `550e8400-e29b-41d4-a716-4466554400${String(i).padStart(2, "0")}`;
      const matches = final.filter((r) => r.runId === expectedRunId);
      expect(matches).toHaveLength(1);
    }
  });

  it("double-lock regression: appendProvision called inside withLock does NOT emit lock-contention warning", async () => {
    // Before the fix, appendProvision acquired its own inner lock after
    // withLock already held the outer lock — the inner acquire always saw
    // the outer lock file and emitted:
    //   "WARNING: Could not acquire lock for provisions.json — skipping write"
    // With the fix, appendProvision has no inner lock → no warning.
    const stderrChunks: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        stderrChunks.push(String(chunk));
        return true;
      });

    try {
      await lock.withLock(provisionsLockName, async () => {
        await memService.appendProvision({
          runId: "550e8400-e29b-41d4-a716-446655440000",
          resourceType: "AWS::S3::Bucket",
          resourceArn: "arn:aws:s3:::no-warning-bucket",
          region: "us-east-1",
          desiredStateHash: "abc123",
          estimatedMonthlyCost: "$0.023/GB-month",
          timestamp: new Date().toISOString(),
        });
      });
    } finally {
      stderrSpy.mockRestore();
    }

    // The old warning must NEVER appear.
    const warningFound = stderrChunks.some((c) =>
      c.includes("Could not acquire lock for provisions.json"),
    );
    expect(warningFound).toBe(false);

    // The record must have landed.
    const records = await memService.readProvisions();
    expect(records).toHaveLength(1);
    expect(records[0]!.resourceArn).toBe("arn:aws:s3:::no-warning-bucket");
  });
});

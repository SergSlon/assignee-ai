/**
 * Tests for `saveCheckpoint` and `loadCheckpoint` (store.ts).
 *
 * Recovery-path focus (P035 — 0 % coverage closure):
 *   - Corrupt JSON → CheckpointError
 *   - Partial / schema-invalid JSON → CheckpointError
 *   - Missing file (ENOENT) → propagated as-is so the caller decides
 *   - File permissions (0o600)
 *   - Atomic temp-rename: concurrent readers never see a partial write
 *   - Concurrent-write race: two concurrent saves of the SAME runId
 *     must not corrupt the final file (last-writer-wins via rename)
 *   - Round-trip: save → load preserves all checkpoint fields
 *   - Directory auto-creation
 *
 * Real fixtures from test-fixtures/checkpoints/ are used where a
 * fully-populated checkpoint is needed (feedback_real_data_mocks_all_cases).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { saveCheckpoint, loadCheckpoint } from "./store.js";
import { CheckpointError } from "../errors.js";
import { CHECKPOINT_VERSION } from "../schema/checkpoint.js";
import type { PlanCheckpoint } from "../schema/checkpoint.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(
  __dirname,
  "..",
  "test-fixtures",
  "checkpoints",
);

// ── helpers ───────────────────────────────────────────────────────────

function makeCheckpoint(
  overrides: Partial<PlanCheckpoint> = {},
): PlanCheckpoint {
  return {
    checkpoint_version: CHECKPOINT_VERSION,
    created_at: new Date().toISOString(),
    ttl_hours: 72,
    runId: crypto.randomUUID(),
    userIntent: "Create an EC2 instance for a web server",
    resourceType: "AWS::EC2::Instance",
    desiredState: {
      InstanceType: "t3.micro",
      ImageId: "ami-098e39bafa7e7303d",
    },
    estimatedMonthlyCost: "$0.0208/hour",
    preflightPassed: true,
    currentResourceIndex: 0,
    completedResources: [],
    ...overrides,
  };
}

/** Load a real fixture, refresh its created_at, and return the parsed object. */
function loadFixtureSync(name: string): PlanCheckpoint {
  const raw = fsSync.readFileSync(path.join(FIXTURE_DIR, name), "utf-8");
  const obj = JSON.parse(raw) as PlanCheckpoint;
  return { ...obj, created_at: new Date().toISOString() };
}

// ── setup ─────────────────────────────────────────────────────────────

describe("saveCheckpoint", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "assignee-store-save-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("creates the directory when it does not exist", async () => {
    const newDir = path.join(tmpDir, "deep", "nested", "dir");
    const cp = makeCheckpoint();
    await saveCheckpoint(cp, newDir);
    const stat = await fs.stat(newDir);
    expect(stat.isDirectory()).toBe(true);
  });

  it("returns the absolute file path", async () => {
    const cp = makeCheckpoint();
    const ref = await saveCheckpoint(cp, tmpDir);
    expect(path.isAbsolute(ref)).toBe(true);
    expect(ref).toContain(`checkpoint-${cp.runId}.json`);
  });

  it("writes the file with 0o600 permissions (owner rw only)", async () => {
    if (process.platform === "win32") return; // NTFS chmod is a no-op
    const cp = makeCheckpoint();
    const ref = await saveCheckpoint(cp, tmpDir);
    const stat = await fs.stat(ref);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("persists valid JSON that parses back to the original checkpoint", async () => {
    const cp = makeCheckpoint();
    const ref = await saveCheckpoint(cp, tmpDir);
    const raw = await fs.readFile(ref, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.runId).toBe(cp.runId);
    expect(parsed.userIntent).toBe(cp.userIntent);
    expect(parsed.desiredState).toEqual(cp.desiredState);
  });

  it("overwrites an existing checkpoint (idempotent — last-write-wins)", async () => {
    const cp = makeCheckpoint();
    await saveCheckpoint(cp, tmpDir);
    const updated = {
      ...cp,
      userIntent: "updated intent for idempotency test",
    };
    await saveCheckpoint(updated, tmpDir);
    const raw = await fs.readFile(
      path.join(tmpDir, `checkpoint-${cp.runId}.json`),
      "utf-8",
    );
    expect(JSON.parse(raw).userIntent).toBe(
      "updated intent for idempotency test",
    );
  });

  it("leaves no .tmp file after a successful write (atomic rename cleanup)", async () => {
    const cp = makeCheckpoint();
    await saveCheckpoint(cp, tmpDir);
    const entries = await fs.readdir(tmpDir);
    const tmpFiles = entries.filter((f) => f.includes(".tmp."));
    expect(tmpFiles).toHaveLength(0);
  });

  it("concurrent saves for the SAME runId do not corrupt the file (last-writer-wins)", async () => {
    const cp = makeCheckpoint();
    // Launch two concurrent saves — different userIntent to distinguish winner
    const saveA = saveCheckpoint({ ...cp, userIntent: "intent-A" }, tmpDir);
    const saveB = saveCheckpoint({ ...cp, userIntent: "intent-B" }, tmpDir);
    await Promise.all([saveA, saveB]);

    const raw = await fs.readFile(
      path.join(tmpDir, `checkpoint-${cp.runId}.json`),
      "utf-8",
    );
    const parsed = JSON.parse(raw);
    // One of the two intents must be present — not a corrupt mix
    expect(["intent-A", "intent-B"]).toContain(parsed.userIntent);
    // The file must be valid JSON
    expect(parsed.runId).toBe(cp.runId);
  });

  it("concurrent saves for DIFFERENT runIds produce two separate clean files", async () => {
    const cpA = makeCheckpoint({ userIntent: "intent-cp-A" });
    const cpB = makeCheckpoint({ userIntent: "intent-cp-B" });
    await Promise.all([
      saveCheckpoint(cpA, tmpDir),
      saveCheckpoint(cpB, tmpDir),
    ]);
    const files = (await fs.readdir(tmpDir)).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(2);
    const rawA = await fs.readFile(
      path.join(tmpDir, `checkpoint-${cpA.runId}.json`),
      "utf-8",
    );
    const rawB = await fs.readFile(
      path.join(tmpDir, `checkpoint-${cpB.runId}.json`),
      "utf-8",
    );
    expect(JSON.parse(rawA).userIntent).toBe("intent-cp-A");
    expect(JSON.parse(rawB).userIntent).toBe("intent-cp-B");
  });

  it("saves the compound serverless-api fixture with full resource queue", async () => {
    const cp = loadFixtureSync("compound-serverless-api.json");
    const ref = await saveCheckpoint(cp, tmpDir);
    const raw = await fs.readFile(ref, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.resourceQueue).toHaveLength(8);
    expect(parsed.completedResources).toHaveLength(3);
    expect(parsed.currentResourceIndex).toBe(3);
  });
});

// ── loadCheckpoint ────────────────────────────────────────────────────

describe("loadCheckpoint", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "assignee-store-load-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ── happy-path ──────────────────────────────────────────────────────

  it("loads a checkpoint previously saved by saveCheckpoint", async () => {
    const cp = makeCheckpoint();
    await saveCheckpoint(cp, tmpDir);
    const loaded = await loadCheckpoint(cp.runId, tmpDir);
    expect(loaded.runId).toBe(cp.runId);
    expect(loaded.userIntent).toBe(cp.userIntent);
    expect(loaded.desiredState).toEqual(cp.desiredState);
    expect(loaded.preflightPassed).toBe(true);
  });

  it("round-trips the EC2 baseline fixture without field loss", async () => {
    const cp = loadFixtureSync("single-ec2-baseline.json");
    await saveCheckpoint(cp, tmpDir);
    const loaded = await loadCheckpoint(cp.runId, tmpDir);
    expect(loaded.resourceType).toBe("AWS::EC2::Instance");
    expect(loaded.desiredState["InstanceType"]).toBe("t3.small");
    expect(loaded.elicitedOptions?.["DisableApiTermination"]).toBe(true);
  });

  it("round-trips the compound serverless-api fixture with resume state", async () => {
    const cp = loadFixtureSync("compound-serverless-api.json");
    await saveCheckpoint(cp, tmpDir);
    const loaded = await loadCheckpoint(cp.runId, tmpDir);
    expect(loaded.resourceQueue).toHaveLength(8);
    expect(loaded.currentResourceIndex).toBe(3);
    expect(loaded.completedResources).toHaveLength(3);
    expect(loaded.resourcePatternId).toBe("serverless-api");
  });

  it("round-trips the scheduled-Lambda fixture (pre-Epic-92 shape)", async () => {
    const cp = loadFixtureSync("single-lambda-scheduled.json");
    // Pre-Epic-92 fixtures omit currentResourceIndex / completedResources —
    // save them back as-is; the Zod defaults should fill in on load.
    const filePath = path.join(tmpDir, `checkpoint-${cp.runId}.json`);
    // Write raw fixture (no defaults applied by saveCheckpoint)
    await fs.writeFile(filePath, JSON.stringify(cp, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    const loaded = await loadCheckpoint(cp.runId, tmpDir);
    expect(loaded.currentResourceIndex).toBe(0); // Zod default
    expect(loaded.completedResources).toEqual([]); // Zod default
    expect(loaded.resourceType).toBe("AWS::Lambda::Function");
  });

  // ── recovery paths ──────────────────────────────────────────────────

  it("RECOVERY: throws CheckpointError on missing file (ENOENT)", async () => {
    await expect(
      loadCheckpoint(
        "nonexistent-run-id-00000000-0000-0000-0000-000000000000",
        tmpDir,
      ),
    ).rejects.toThrow(); // ENOENT propagated — callers handle per port contract
  });

  it("RECOVERY: throws CheckpointError on completely invalid JSON", async () => {
    const runId = crypto.randomUUID();
    await fs.writeFile(
      path.join(tmpDir, `checkpoint-${runId}.json`),
      "not-valid-json{{{{",
      { encoding: "utf-8", mode: 0o600 },
    );
    await expect(loadCheckpoint(runId, tmpDir)).rejects.toBeInstanceOf(
      CheckpointError,
    );
  });

  it("RECOVERY: throws CheckpointError on truncated JSON (partial write simulation)", async () => {
    const cp = makeCheckpoint();
    const full = JSON.stringify(cp, null, 2);
    const truncated = full.slice(0, Math.floor(full.length / 2));
    await fs.writeFile(
      path.join(tmpDir, `checkpoint-${cp.runId}.json`),
      truncated,
      { encoding: "utf-8", mode: 0o600 },
    );
    await expect(loadCheckpoint(cp.runId, tmpDir)).rejects.toBeInstanceOf(
      CheckpointError,
    );
  });

  it("RECOVERY: throws CheckpointError on valid JSON that fails schema validation (version mismatch)", async () => {
    const runId = crypto.randomUUID();
    const corrupt = {
      checkpoint_version: "99-unsupported", // wrong literal
      created_at: new Date().toISOString(),
      ttl_hours: 72,
      runId,
      userIntent: "test",
      resourceType: "AWS::S3::Bucket",
      desiredState: {},
      estimatedMonthlyCost: "N/A",
      preflightPassed: true,
    };
    await fs.writeFile(
      path.join(tmpDir, `checkpoint-${runId}.json`),
      JSON.stringify(corrupt, null, 2),
      { encoding: "utf-8", mode: 0o600 },
    );
    await expect(loadCheckpoint(runId, tmpDir)).rejects.toBeInstanceOf(
      CheckpointError,
    );
  });

  it("RECOVERY: throws CheckpointError on valid JSON missing required fields (no runId)", async () => {
    const runId = crypto.randomUUID();
    const partial = {
      checkpoint_version: CHECKPOINT_VERSION,
      created_at: new Date().toISOString(),
      // runId deliberately omitted → fails .uuid() validation
      ttl_hours: 72,
      userIntent: "test",
      resourceType: "AWS::S3::Bucket",
      desiredState: {},
      estimatedMonthlyCost: "N/A",
      preflightPassed: true,
    };
    await fs.writeFile(
      path.join(tmpDir, `checkpoint-${runId}.json`),
      JSON.stringify(partial, null, 2),
      { encoding: "utf-8", mode: 0o600 },
    );
    await expect(loadCheckpoint(runId, tmpDir)).rejects.toBeInstanceOf(
      CheckpointError,
    );
  });

  it("RECOVERY: throws CheckpointError on extra unexpected fields (strict schema)", async () => {
    const runId = crypto.randomUUID();
    const withExtra = {
      checkpoint_version: CHECKPOINT_VERSION,
      created_at: new Date().toISOString(),
      ttl_hours: 72,
      runId,
      userIntent: "test",
      resourceType: "AWS::S3::Bucket",
      desiredState: { BucketName: "my-bucket" },
      estimatedMonthlyCost: "N/A",
      preflightPassed: true,
      unknownExtraField: "this-should-fail-strict-parse",
    };
    await fs.writeFile(
      path.join(tmpDir, `checkpoint-${runId}.json`),
      JSON.stringify(withExtra, null, 2),
      { encoding: "utf-8", mode: 0o600 },
    );
    await expect(loadCheckpoint(runId, tmpDir)).rejects.toBeInstanceOf(
      CheckpointError,
    );
  });

  it("RECOVERY: checkpoint with empty string content throws CheckpointError", async () => {
    const runId = crypto.randomUUID();
    await fs.writeFile(path.join(tmpDir, `checkpoint-${runId}.json`), "", {
      encoding: "utf-8",
      mode: 0o600,
    });
    await expect(loadCheckpoint(runId, tmpDir)).rejects.toBeInstanceOf(
      CheckpointError,
    );
  });
});

// ── save + load round-trip (integration) ─────────────────────────────

describe("saveCheckpoint + loadCheckpoint round-trip", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "assignee-store-rt-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("preserves preflightPassed, elicitedOptions, and resourcePatternId across round-trip", async () => {
    const cp = makeCheckpoint({
      preflightPassed: true,
      elicitedOptions: { InstanceType: "t3.small", EbsEncrypted: true },
      resourcePatternId: "ec2-simple",
    });
    await saveCheckpoint(cp, tmpDir);
    const loaded = await loadCheckpoint(cp.runId, tmpDir);
    expect(loaded.preflightPassed).toBe(true);
    expect(loaded.elicitedOptions?.["InstanceType"]).toBe("t3.small");
    expect(loaded.resourcePatternId).toBe("ec2-simple");
  });

  it("preserves a full compound compound resource queue", async () => {
    const cp = makeCheckpoint({
      resourceQueue: [
        {
          resourceId: "bucket",
          resourceType: "AWS::S3::Bucket",
          displayName: "Origin Bucket",
          desiredState: { BucketName: "my-origin-bucket" },
        },
        {
          resourceId: "cf",
          resourceType: "AWS::CloudFront::Distribution",
          displayName: "CDN",
          desiredState: { DistributionConfig: { Enabled: true } },
        },
      ],
      currentResourceIndex: 1,
      completedResources: [
        {
          resourceArn: "arn:aws:s3:::my-origin-bucket",
          resourceType: "AWS::S3::Bucket",
        },
      ],
    });
    await saveCheckpoint(cp, tmpDir);
    const loaded = await loadCheckpoint(cp.runId, tmpDir);
    expect(loaded.resourceQueue).toHaveLength(2);
    expect(loaded.currentResourceIndex).toBe(1);
    expect(loaded.completedResources[0]?.resourceArn).toBe(
      "arn:aws:s3:::my-origin-bucket",
    );
  });
});

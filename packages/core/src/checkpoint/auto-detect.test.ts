/**
 * Tests for `findNewestValidCheckpoint` (auto-detect.ts).
 *
 * Recovery-path focus (P035 — 0 % coverage closure):
 *   - Directory does not exist → returns null (no throw)
 *   - Empty directory → returns null
 *   - All checkpoints expired → returns null
 *   - All checkpoints fail preflight → returns null
 *   - All checkpoints have empty desiredState → returns null
 *   - Mixed: some corrupt JSON files, some valid → skips corrupt
 *   - Mixed: expired + valid → returns only the valid one
 *   - Multiple valid checkpoints → returns newest by created_at
 *   - Partial / truncated JSON files → skipped gracefully
 *   - Version-mismatch JSON → skipped (schema parse fails)
 *   - Files that don't match the checkpoint-*.json pattern → ignored
 *
 * Real fixtures used where fully-populated checkpoints are needed.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { findNewestValidCheckpoint } from "./auto-detect.js";
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
    userIntent: "Create an S3 bucket named test-bucket",
    resourceType: "AWS::S3::Bucket",
    desiredState: { BucketName: "test-bucket" },
    estimatedMonthlyCost: "$0.02",
    preflightPassed: true,
    currentResourceIndex: 0,
    completedResources: [],
    ...overrides,
  };
}

async function writeCheckpoint(dir: string, cp: PlanCheckpoint): Promise<void> {
  const filePath = path.join(dir, `checkpoint-${cp.runId}.json`);
  await fs.writeFile(filePath, JSON.stringify(cp, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
}

/** Load a real fixture, refresh created_at, and return the parsed object. */
function loadFixtureSync(name: string): PlanCheckpoint {
  const raw = fsSync.readFileSync(path.join(FIXTURE_DIR, name), "utf-8");
  const obj = JSON.parse(raw) as PlanCheckpoint;
  return { ...obj, created_at: new Date().toISOString() };
}

// ── setup ─────────────────────────────────────────────────────────────

describe("findNewestValidCheckpoint", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "assignee-autodetect-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ── directory-level recovery ─────────────────────────────────────────

  it("RECOVERY: returns null when the directory does not exist (no throw)", async () => {
    const missing = path.join(tmpDir, "does-not-exist");
    const result = await findNewestValidCheckpoint(missing);
    expect(result).toBeNull();
  });

  it("returns null for an empty directory", async () => {
    const result = await findNewestValidCheckpoint(tmpDir);
    expect(result).toBeNull();
  });

  it("returns null when directory contains no checkpoint-*.json files", async () => {
    // Write files with wrong naming pattern
    await fs.writeFile(path.join(tmpDir, "not-a-checkpoint.json"), '{"x":1}');
    await fs.writeFile(path.join(tmpDir, "checkpoint.txt"), "text");
    await fs.writeFile(path.join(tmpDir, "README.md"), "readme");
    const result = await findNewestValidCheckpoint(tmpDir);
    expect(result).toBeNull();
  });

  // ── corrupt-file recovery ─────────────────────────────────────────────

  it("RECOVERY: skips checkpoint files with invalid JSON, returns null when all are corrupt", async () => {
    const id1 = crypto.randomUUID();
    const id2 = crypto.randomUUID();
    await fs.writeFile(
      path.join(tmpDir, `checkpoint-${id1}.json`),
      "not-valid-json{{{{",
    );
    await fs.writeFile(path.join(tmpDir, `checkpoint-${id2}.json`), "}{broken");
    const result = await findNewestValidCheckpoint(tmpDir);
    expect(result).toBeNull();
  });

  it("RECOVERY: skips truncated (partial) checkpoint files silently", async () => {
    const cp = makeCheckpoint();
    const full = JSON.stringify(cp, null, 2);
    const truncated = full.slice(0, Math.floor(full.length / 3));
    await fs.writeFile(
      path.join(tmpDir, `checkpoint-${cp.runId}.json`),
      truncated,
    );
    const result = await findNewestValidCheckpoint(tmpDir);
    expect(result).toBeNull();
  });

  it("RECOVERY: skips files whose JSON does not match PlanCheckpointSchema (version mismatch)", async () => {
    const runId = crypto.randomUUID();
    const badVersion = {
      checkpoint_version: "99-unsupported",
      created_at: new Date().toISOString(),
      ttl_hours: 72,
      runId,
      userIntent: "test",
      resourceType: "AWS::S3::Bucket",
      desiredState: { BucketName: "b" },
      estimatedMonthlyCost: "N/A",
      preflightPassed: true,
    };
    await fs.writeFile(
      path.join(tmpDir, `checkpoint-${runId}.json`),
      JSON.stringify(badVersion, null, 2),
    );
    const result = await findNewestValidCheckpoint(tmpDir);
    expect(result).toBeNull();
  });

  it("RECOVERY: skips files with valid JSON but extra top-level fields (strict schema)", async () => {
    // PlanCheckpointSchema.safeParse (non-strict) is used by auto-detect,
    // so unknown extra fields are silently stripped — this should succeed.
    const cp = makeCheckpoint();
    const withExtra = { ...cp, unexpectedField: "should-be-stripped" };
    await fs.writeFile(
      path.join(tmpDir, `checkpoint-${cp.runId}.json`),
      JSON.stringify(withExtra, null, 2),
    );
    // auto-detect uses safeParse (not strict) so the extra field is tolerated
    const result = await findNewestValidCheckpoint(tmpDir);
    expect(result).not.toBeNull();
    expect(result?.runId).toBe(cp.runId);
  });

  it("RECOVERY: mixes corrupt + valid checkpoint files — returns the valid one", async () => {
    const corruptId = crypto.randomUUID();
    const goodCp = makeCheckpoint();

    await fs.writeFile(
      path.join(tmpDir, `checkpoint-${corruptId}.json`),
      "not-valid-json",
    );
    await writeCheckpoint(tmpDir, goodCp);

    const result = await findNewestValidCheckpoint(tmpDir);
    expect(result).not.toBeNull();
    expect(result?.runId).toBe(goodCp.runId);
  });

  // ── TTL / preflight / desiredState filter recovery ────────────────────

  it("RECOVERY: returns null when all checkpoints are expired", async () => {
    const expired = makeCheckpoint({
      created_at: new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString(),
      ttl_hours: 72,
    });
    await writeCheckpoint(tmpDir, expired);
    const result = await findNewestValidCheckpoint(tmpDir);
    expect(result).toBeNull();
  });

  it("RECOVERY: returns null when all checkpoints have preflightPassed=false", async () => {
    const failed = makeCheckpoint({ preflightPassed: false });
    await writeCheckpoint(tmpDir, failed);
    const result = await findNewestValidCheckpoint(tmpDir);
    expect(result).toBeNull();
  });

  it("RECOVERY: returns null when all checkpoints have empty desiredState", async () => {
    const empty = makeCheckpoint({ desiredState: {} });
    await writeCheckpoint(tmpDir, empty);
    const result = await findNewestValidCheckpoint(tmpDir);
    expect(result).toBeNull();
  });

  it("RECOVERY: mixes expired + valid — returns only the valid one", async () => {
    const expired = makeCheckpoint({
      created_at: new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString(),
      ttl_hours: 72,
    });
    const valid = makeCheckpoint();

    await writeCheckpoint(tmpDir, expired);
    await writeCheckpoint(tmpDir, valid);

    const result = await findNewestValidCheckpoint(tmpDir);
    expect(result?.runId).toBe(valid.runId);
  });

  it("RECOVERY: mixes failed-preflight + valid — returns only the valid one", async () => {
    const failed = makeCheckpoint({ preflightPassed: false });
    const valid = makeCheckpoint();

    await writeCheckpoint(tmpDir, failed);
    await writeCheckpoint(tmpDir, valid);

    const result = await findNewestValidCheckpoint(tmpDir);
    expect(result?.runId).toBe(valid.runId);
  });

  // ── newest-selection semantics ────────────────────────────────────────

  it("returns the single valid checkpoint", async () => {
    const cp = makeCheckpoint();
    await writeCheckpoint(tmpDir, cp);
    const result = await findNewestValidCheckpoint(tmpDir);
    expect(result?.runId).toBe(cp.runId);
  });

  it("returns the NEWEST of multiple valid checkpoints (newest by created_at)", async () => {
    const older = makeCheckpoint({
      created_at: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(), // 5h ago
    });
    const newer = makeCheckpoint({
      created_at: new Date().toISOString(),
    });
    const middle = makeCheckpoint({
      created_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2h ago
    });

    await writeCheckpoint(tmpDir, older);
    await writeCheckpoint(tmpDir, newer);
    await writeCheckpoint(tmpDir, middle);

    const result = await findNewestValidCheckpoint(tmpDir);
    expect(result?.runId).toBe(newer.runId);
  });

  it("returns correct checkpoint when the oldest is expired and newest is valid", async () => {
    const expired = makeCheckpoint({
      created_at: new Date(Date.now() - 200 * 60 * 60 * 1000).toISOString(),
      ttl_hours: 72,
    });
    const fresh = makeCheckpoint({
      created_at: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
    });
    const freshest = makeCheckpoint({
      created_at: new Date().toISOString(),
    });

    await writeCheckpoint(tmpDir, expired);
    await writeCheckpoint(tmpDir, fresh);
    await writeCheckpoint(tmpDir, freshest);

    const result = await findNewestValidCheckpoint(tmpDir);
    expect(result?.runId).toBe(freshest.runId);
  });

  // ── real-fixture integration ─────────────────────────────────────────

  it("finds the EC2 baseline fixture when staged in the directory", async () => {
    const cp = loadFixtureSync("single-ec2-baseline.json");
    await writeCheckpoint(tmpDir, cp);
    const result = await findNewestValidCheckpoint(tmpDir);
    expect(result?.runId).toBe(cp.runId);
    expect(result?.resourceType).toBe("AWS::EC2::Instance");
  });

  it("finds the compound serverless-api fixture with resume state", async () => {
    const cp = loadFixtureSync("compound-serverless-api.json");
    await writeCheckpoint(tmpDir, cp);
    const result = await findNewestValidCheckpoint(tmpDir);
    expect(result?.runId).toBe(cp.runId);
    expect(result?.currentResourceIndex).toBe(3);
    expect(result?.completedResources).toHaveLength(3);
    expect(result?.resourceQueue).toHaveLength(8);
  });

  it("prefers the compound fixture over the EC2 baseline when the compound is newer", async () => {
    const ec2 = loadFixtureSync("single-ec2-baseline.json");
    const compound = loadFixtureSync("compound-serverless-api.json");

    // Force compound to be the newest
    const newerCompound: PlanCheckpoint = {
      ...compound,
      created_at: new Date(Date.now() + 1000).toISOString(), // slightly in the future is fine
    };
    const olderEc2: PlanCheckpoint = {
      ...ec2,
      created_at: new Date(Date.now() - 3600 * 1000).toISOString(),
    };

    await writeCheckpoint(tmpDir, olderEc2);
    await writeCheckpoint(tmpDir, newerCompound);

    const result = await findNewestValidCheckpoint(tmpDir);
    expect(result?.runId).toBe(newerCompound.runId);
    expect(result?.resourcePatternId).toBe("serverless-api");
  });
});

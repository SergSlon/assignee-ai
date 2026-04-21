/**
 * Tests for `loadCheckpointFromPath`.
 *
 * Focus areas (Story e92.1.d — Epic 89 C-05):
 *   - Pre-Epic-92 fixtures (missing `currentResourceIndex` +
 *     `completedResources`) parse with default values applied; no
 *     throw on backwards-compat load.
 *   - Post-Epic-92 fixtures with explicit resume state round-trip.
 *   - The loader's existing TTL / preflight / desiredState guards
 *     still fire after the schema change.
 *   - Round-trip: serialiser → saveCheckpoint-equivalent (write to
 *     tmp) → loadCheckpointFromPath preserves everything.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCheckpointFromPath } from "./loader.js";
import { serializeCheckpoint } from "./serializer.js";
import { CheckpointError } from "../errors.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(
  __dirname,
  "..",
  "test-fixtures",
  "checkpoints",
);

/**
 * Read a fixture, refresh its `created_at` to "now" so the TTL check
 * stays green regardless of when the test runs, and write to a tmp
 * file. Returns the tmp path. Fixtures ship with historical
 * timestamps so the source-controlled JSON is diff-friendly; tests
 * rewrite the timestamp on the fly.
 */
async function stageFixture(
  name: string,
  tmpDir: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const raw = fs.readFileSync(path.join(FIXTURE_DIR, name), "utf-8");
  const obj = {
    ...JSON.parse(raw),
    created_at: new Date().toISOString(),
    ...overrides,
  };
  const filePath = path.join(tmpDir, name);
  await fsp.writeFile(filePath, JSON.stringify(obj, null, 2), "utf-8");
  return filePath;
}

describe("loadCheckpointFromPath", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "checkpoint-loader-"));
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  // ─── Story e92.1.d — backwards-compat ────────────────────────────────
  describe("Story e92.1.d — backwards-compat (pre-Epic-92 fixtures)", () => {
    it("loads pre-Epic-92 EC2 baseline without the new fields and defaults apply", async () => {
      const filePath = await stageFixture("single-ec2-baseline.json", tmpDir);
      const cp = await loadCheckpointFromPath(filePath);
      expect(cp.currentResourceIndex).toBe(0);
      expect(cp.completedResources).toEqual([]);
      expect(cp.resourceType).toBe("AWS::EC2::Instance");
      expect(cp.preflightPassed).toBe(true);
    });

    it("loads pre-Epic-92 scheduled-Lambda compound without the new fields", async () => {
      const filePath = await stageFixture(
        "single-lambda-scheduled.json",
        tmpDir,
      );
      const cp = await loadCheckpointFromPath(filePath);
      expect(cp.currentResourceIndex).toBe(0);
      expect(cp.completedResources).toEqual([]);
      expect(cp.resourceQueue).toHaveLength(2);
      // Old on-disk shape: per-queue desiredState is {} — we do not
      // back-fill. The serializer produces {} too when callers have
      // not been upgraded; schema stays happy.
      expect(cp.resourceQueue?.[0]?.desiredState).toEqual({});
    });

    it("does NOT throw on a pre-Epic-92 checkpoint that omits both new fields", async () => {
      const filePath = await stageFixture("single-ec2-baseline.json", tmpDir);
      await expect(loadCheckpointFromPath(filePath)).resolves.toBeDefined();
    });
  });

  // ─── Story e92.1.d — forward-compat ─────────────────────────────────
  describe("Story e92.1.d — forward-compat (post-Epic-92 fixtures)", () => {
    it("loads compound serverless-api with populated resume state", async () => {
      const filePath = await stageFixture(
        "compound-serverless-api.json",
        tmpDir,
      );
      const cp = await loadCheckpointFromPath(filePath);
      expect(cp.currentResourceIndex).toBe(3);
      expect(cp.completedResources).toHaveLength(3);
      expect(cp.resourceQueue).toHaveLength(8);
      // The crucial C-05 fix assertion — per-queue desiredState is
      // populated, NOT the old `{}` literal.
      expect(
        Object.keys(cp.resourceQueue?.[0]?.desiredState ?? {}).length,
      ).toBeGreaterThan(0);
      expect(cp.resourceQueue?.[0]?.desiredState).toMatchObject({
        RoleName: expect.stringContaining("assignee-iam-execution-role"),
      });
      // Account IDs redacted to <ACCOUNT_ID> in the on-disk fixture.
      expect(cp.completedResources[0]?.resourceArn).toContain("<ACCOUNT_ID>");
    });
  });

  // ─── Existing loader guards stay wired after the schema change ──────
  describe("loader guards (regression)", () => {
    it("throws CheckpointError when file does not exist", async () => {
      const filePath = path.join(tmpDir, "no-such-file.json");
      await expect(loadCheckpointFromPath(filePath)).rejects.toBeInstanceOf(
        CheckpointError,
      );
    });

    it("throws CheckpointError when JSON is malformed", async () => {
      const filePath = path.join(tmpDir, "corrupt.json");
      await fsp.writeFile(filePath, "not-valid-json", "utf-8");
      await expect(loadCheckpointFromPath(filePath)).rejects.toBeInstanceOf(
        CheckpointError,
      );
    });

    it("throws CheckpointError when TTL is expired", async () => {
      const filePath = await stageFixture("single-ec2-baseline.json", tmpDir, {
        // 100 hours ago — beyond the 72h TTL in the fixture
        created_at: new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString(),
      });
      await expect(loadCheckpointFromPath(filePath)).rejects.toBeInstanceOf(
        CheckpointError,
      );
    });

    it("throws CheckpointError when preflightPassed is false", async () => {
      const filePath = await stageFixture("single-ec2-baseline.json", tmpDir, {
        preflightPassed: false,
      });
      await expect(loadCheckpointFromPath(filePath)).rejects.toBeInstanceOf(
        CheckpointError,
      );
    });

    it("throws CheckpointError when desiredState is empty", async () => {
      const filePath = await stageFixture("single-ec2-baseline.json", tmpDir, {
        desiredState: {},
      });
      await expect(loadCheckpointFromPath(filePath)).rejects.toBeInstanceOf(
        CheckpointError,
      );
    });

    it("calls the integrity verifier hook when supplied", async () => {
      const filePath = await stageFixture(
        "compound-serverless-api.json",
        tmpDir,
      );
      let called = false;
      await loadCheckpointFromPath(filePath, {
        verifyIntegrity: async () => {
          called = true;
        },
      });
      expect(called).toBe(true);
    });

    it("propagates rejection from the integrity verifier", async () => {
      const filePath = await stageFixture(
        "compound-serverless-api.json",
        tmpDir,
      );
      await expect(
        loadCheckpointFromPath(filePath, {
          verifyIntegrity: () => {
            throw new CheckpointError("HMAC mismatch");
          },
        }),
      ).rejects.toBeInstanceOf(CheckpointError);
    });
  });

  // ─── Round-trip integration ──────────────────────────────────────────
  describe("round-trip serialiser → disk → loader", () => {
    it("preserves compound resume state across a full round-trip", async () => {
      const checkpoint = serializeCheckpoint({
        runId: "ae5a006f-e4d9-4819-8788-c35b5dab3723",
        userIntent: "Create a serverless API with Lambda and API Gateway",
        resourceType: "AWS::Logs::LogGroup",
        resourcePattern: { patternId: "serverless-api" },
        desiredState: {
          LogGroupName: "/aws/apigateway/serverless-api",
          RetentionInDays: 14,
        },
        estimatedMonthlyCost: "N/A",
        preflightPassed: true,
        resourceQueue: [
          {
            resourceId: "iam-execution-role",
            resourceType: "AWS::IAM::Role",
            displayName: "Lambda Execution Role",
            desiredState: {
              RoleName: "assignee-iam-execution-role-ae5a006f",
            },
          },
          {
            resourceId: "lambda-fn",
            resourceType: "AWS::Lambda::Function",
            displayName: "Lambda Function",
            desiredState: {
              FunctionName: "assignee-lambda-fn-ae5a006f",
              Runtime: "nodejs22.x",
            },
          },
        ],
        currentResourceIndex: 1,
        completedResources: [
          {
            resourceArn:
              "arn:aws:iam::111111111111:role/assignee-iam-execution-role-ae5a006f",
            resourceType: "AWS::IAM::Role",
          },
        ],
      });
      const filePath = path.join(tmpDir, "round-trip.json");
      await fsp.writeFile(
        filePath,
        JSON.stringify(checkpoint, null, 2),
        "utf-8",
      );
      const loaded = await loadCheckpointFromPath(filePath);
      expect(loaded.currentResourceIndex).toBe(1);
      expect(loaded.completedResources).toHaveLength(1);
      expect(loaded.resourceQueue).toHaveLength(2);
      expect(loaded.resourceQueue?.[0]?.desiredState).toMatchObject({
        RoleName: "assignee-iam-execution-role-ae5a006f",
      });
      expect(loaded.resourceQueue?.[1]?.desiredState).toMatchObject({
        FunctionName: "assignee-lambda-fn-ae5a006f",
        Runtime: "nodejs22.x",
      });
    });
  });
});

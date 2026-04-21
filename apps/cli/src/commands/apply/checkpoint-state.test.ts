/**
 * Tests for `buildCheckpointState`.
 *
 * Focus (Story e92.1.d-followup — Epic 89 C-05 closure):
 *   - Loads real `test-fixtures/checkpoints/*.json` fixtures via the
 *     promoted `loadCheckpointFromPath` (no fake JSON literals) and
 *     feeds them to `buildCheckpointState` end-to-end.
 *   - The populated `compound-serverless-api.json` fixture is the
 *     load-bearing assertion that propagation works: on resume the
 *     returned state must carry `currentResourceIndex: 3` AND a
 *     3-element `completedResources` hydrated to `ResourceResult`
 *     shape (resourceId recovered from the queue, executionStatus:
 *     SUCCESS).
 *   - The pre-Epic-92 `single-ec2-baseline.json` fixture pins
 *     backwards-compat: neither field appears on the returned state
 *     (the loader defaults them to `0` / `[]`, and the builder must
 *     drop them rather than emit the default into the graph).
 *   - BP re-evaluation is bypassed by passing a userConfig with
 *     `bestPractices.enforcement: SKIP` — tests isolate the resume-
 *     propagation concern and do not exercise the BP pipeline here
 *     (covered by Story 41.3 tests). This is mocking-I/O-only in
 *     spirit: the on-disk BP rules are real, we just opt out of the
 *     evaluation branch.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { BPEnforcementLevel, ExecutionStatus } from "@assignee/core";
import { loadCheckpointFromPath } from "@assignee/core/checkpoint";
import type { UserConfig } from "../../config/user-config-loader.js";

vi.mock("../../utils/logger.js", () => ({
  log: vi.fn(),
  LOG_ACTIONS: {
    BP_EVALUATED: "bp_evaluated",
  },
}));

const { buildCheckpointState } = await import("./checkpoint-state.js");

// Resolve fixtures relative to the @assignee/core package — the
// monorepo symlinks `@assignee/core` into `packages/core`, so we
// reach the fixtures via the same path every test uses.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  "packages",
  "core",
  "src",
  "test-fixtures",
  "checkpoints",
);

/**
 * Stage a checkpoint fixture in a tmpdir with `created_at` rewritten
 * to `now` so the 72h TTL stays green regardless of when the test
 * runs. Returns the tmp path suitable for `loadCheckpointFromPath`.
 */
async function stageFixture(name: string, tmpDir: string): Promise<string> {
  const raw = fs.readFileSync(path.join(FIXTURE_DIR, name), "utf-8");
  const obj = { ...JSON.parse(raw), created_at: new Date().toISOString() };
  const filePath = path.join(tmpDir, name);
  await fsp.writeFile(filePath, JSON.stringify(obj, null, 2), "utf-8");
  return filePath;
}

/** UserConfig that skips BP re-evaluation — see module JSDoc. */
const BP_SKIP_CONFIG: UserConfig = {
  bestPractices: { enforcement: BPEnforcementLevel.SKIP },
} as UserConfig;

describe("buildCheckpointState — Story e92.1.d-followup", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(
      path.join(os.tmpdir(), "checkpoint-state-builder-"),
    );
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  describe("resume propagation (compound-serverless-api fixture)", () => {
    it("propagates currentResourceIndex + completedResources into graph state", async () => {
      const filePath = await stageFixture(
        "compound-serverless-api.json",
        tmpDir,
      );
      const checkpoint = await loadCheckpointFromPath(filePath);

      const state = buildCheckpointState(
        checkpoint,
        {},
        BP_SKIP_CONFIG,
        undefined,
      );

      // Index carries through unchanged.
      expect(state["currentResourceIndex"]).toBe(3);

      // Hydrated to ResourceResult shape — 3 entries matching the
      // first 3 slots of the resourceQueue.
      const completed = state["completedResources"] as Array<
        Record<string, unknown>
      >;
      expect(completed).toHaveLength(3);

      // resourceId recovered from resourceQueue[0..2].
      expect(completed[0]).toMatchObject({
        resourceId: "iam-execution-role",
        resourceType: "AWS::IAM::Role",
        executionStatus: ExecutionStatus.SUCCESS,
      });
      expect(completed[1]).toMatchObject({
        resourceId: "lambda-fn",
        resourceType: "AWS::Lambda::Function",
        executionStatus: ExecutionStatus.SUCCESS,
      });
      expect(completed[2]).toMatchObject({
        resourceId: "access-log-group",
        resourceType: "AWS::Logs::LogGroup",
        executionStatus: ExecutionStatus.SUCCESS,
      });

      // ARNs preserved verbatim from the checkpoint (account IDs
      // stay redacted as `<ACCOUNT_ID>` in the fixture).
      expect(completed[0]?.["resourceArn"]).toContain("<ACCOUNT_ID>");
      expect(completed[0]?.["resourceArn"]).toContain(
        ":role/assignee-iam-execution-role",
      );
    });

    it("leaves resourceQueue intact so plan-generator can advance through it", async () => {
      const filePath = await stageFixture(
        "compound-serverless-api.json",
        tmpDir,
      );
      const checkpoint = await loadCheckpointFromPath(filePath);
      const state = buildCheckpointState(
        checkpoint,
        {},
        BP_SKIP_CONFIG,
        undefined,
      );
      const queue = state["resourceQueue"] as unknown[];
      expect(queue).toHaveLength(8);
    });

    it("sets checkpointResumed and preserves runId for audit continuity", async () => {
      const filePath = await stageFixture(
        "compound-serverless-api.json",
        tmpDir,
      );
      const checkpoint = await loadCheckpointFromPath(filePath);
      const state = buildCheckpointState(
        checkpoint,
        {},
        BP_SKIP_CONFIG,
        undefined,
      );
      expect(state["checkpointResumed"]).toBe(true);
      expect(state["runId"]).toBe(checkpoint.runId);
    });
  });

  describe("backwards-compat (pre-Epic-92 fixtures)", () => {
    it("does NOT emit resume fields on single-ec2-baseline (no queue, no completions)", async () => {
      const filePath = await stageFixture("single-ec2-baseline.json", tmpDir);
      const checkpoint = await loadCheckpointFromPath(filePath);

      // Sanity: loader defaulted the new fields.
      expect(checkpoint.currentResourceIndex).toBe(0);
      expect(checkpoint.completedResources).toEqual([]);

      const state = buildCheckpointState(
        checkpoint,
        {},
        BP_SKIP_CONFIG,
        undefined,
      );

      // The builder must DROP the default values so the graph state
      // shape stays byte-for-byte identical to the pre-fix path.
      expect(state).not.toHaveProperty("currentResourceIndex");
      expect(state).not.toHaveProperty("completedResources");
    });

    it("does NOT emit resume fields on single-lambda-scheduled (compound queue, no progress)", async () => {
      const filePath = await stageFixture(
        "single-lambda-scheduled.json",
        tmpDir,
      );
      const checkpoint = await loadCheckpointFromPath(filePath);

      expect(checkpoint.currentResourceIndex).toBe(0);
      expect(checkpoint.completedResources).toEqual([]);
      expect(checkpoint.resourceQueue).toHaveLength(2);

      const state = buildCheckpointState(
        checkpoint,
        {},
        BP_SKIP_CONFIG,
        undefined,
      );

      expect(state).not.toHaveProperty("currentResourceIndex");
      expect(state).not.toHaveProperty("completedResources");
      // resourceQueue still flows through (pre-fix behaviour).
      expect(state["resourceQueue"]).toHaveLength(2);
    });
  });
});

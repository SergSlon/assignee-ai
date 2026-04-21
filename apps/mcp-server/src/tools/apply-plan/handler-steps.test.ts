/**
 * Tests for apply-plan handler-steps resume wiring.
 *
 * Focus (Story e92.1.d-followup — Epic 89 C-05 closure):
 *   - `hydrateCheckpointCompletedResources` zips the compact on-disk
 *     shape against `resourceQueue` to recover `resourceId` — the key
 *     the marker-resolver looks up for cross-resource references.
 *   - `executeAndAudit` forwards `currentResourceIndex` +
 *     `completedResources` into the graph-invoke payload when the
 *     loaded checkpoint carries non-default values.
 *   - Pre-Epic-92 / single-resource checkpoints (the default `0` /
 *     `[]` shape produced by the loader's optional defaults) do NOT
 *     emit the two fields into the graph payload — the graph initial
 *     state stays byte-for-byte identical to the pre-fix path.
 *
 * Uses real `packages/core/src/test-fixtures/checkpoints/*.json`
 * fixtures through the promoted loader — no fake JSON literals.
 * The audit writer's `ASSIGNEE_MCP_AUDIT_DIR` is redirected to a
 * tmpdir per test so the real writer runs (matches the pattern used
 * by `audit.test.ts`).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ExecutionStatus, type PlanCheckpoint } from "@assignee/core";
import { loadCheckpointFromPath } from "@assignee/core/checkpoint";

import {
  executeAndAudit,
  hydrateCheckpointCompletedResources,
} from "./handler-steps.js";
import type { GraphContext } from "../../services/graph-init.js";

// Resolve fixtures via the @assignee/core package — monorepo symlinks
// make the path deterministic from this test file.
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
 * Stage a checkpoint fixture with a fresh `created_at` so the 72h
 * TTL stays green. Returns the tmp path (ready for the real
 * loader).
 */
async function stageFixture(name: string, tmpDir: string): Promise<string> {
  const raw = fs.readFileSync(path.join(FIXTURE_DIR, name), "utf-8");
  const obj = { ...JSON.parse(raw), created_at: new Date().toISOString() };
  const filePath = path.join(tmpDir, name);
  await fsp.writeFile(filePath, JSON.stringify(obj, null, 2), "utf-8");
  return filePath;
}

/**
 * Build a mock GraphContext whose `graph.invoke` captures every
 * payload it receives (so the test can assert on the first invocation's
 * initial state). `getState` is stubbed to terminate the provisioning
 * loop after one iteration.
 */
function makeCapturingGraphContext(): {
  ctx: GraphContext;
  invokeCalls: unknown[][];
} {
  const invokeCalls: unknown[][] = [];
  const terminalState = {
    executionStatus: ExecutionStatus.SUCCESS,
    resourceArn: "arn:aws:logs:us-east-1:111111111111:log-group:test",
    resourceType: "AWS::Logs::LogGroup",
    estimatedMonthlyCost: "N/A",
    securityFindings: [],
    completedResources: [],
  };
  const ctx: GraphContext = {
    graph: {
      invoke: vi.fn().mockImplementation((...args: unknown[]) => {
        invokeCalls.push(args);
        return Promise.resolve(terminalState);
      }),
      getState: vi.fn().mockResolvedValue({ values: terminalState, next: [] }),
    },
    cleanup: vi.fn().mockResolvedValue(undefined),
  } as unknown as GraphContext;
  return { ctx, invokeCalls };
}

describe("hydrateCheckpointCompletedResources", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "hydrate-completed-"));
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it("zips compound-serverless-api completions against the queue to recover resourceId", async () => {
    const filePath = await stageFixture("compound-serverless-api.json", tmpDir);
    const checkpoint = await loadCheckpointFromPath(filePath);

    const hydrated = hydrateCheckpointCompletedResources(checkpoint);

    expect(hydrated).toHaveLength(3);
    expect(hydrated[0]).toEqual({
      resourceId: "iam-execution-role",
      resourceType: "AWS::IAM::Role",
      resourceArn: checkpoint.completedResources[0]?.resourceArn,
      executionStatus: ExecutionStatus.SUCCESS,
    });
    expect(hydrated[1]?.resourceId).toBe("lambda-fn");
    expect(hydrated[2]?.resourceId).toBe("access-log-group");
  });

  it("returns [] for pre-Epic-92 checkpoints with no completions", async () => {
    const filePath = await stageFixture("single-ec2-baseline.json", tmpDir);
    const checkpoint = await loadCheckpointFromPath(filePath);
    expect(hydrateCheckpointCompletedResources(checkpoint)).toEqual([]);
  });
});

describe("executeAndAudit — resume propagation", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "executeAndAudit-"));
    // Redirect the audit writer to the tmpdir so it doesn't clutter
    // the workspace (pattern borrowed from audit.test.ts).
    process.env["ASSIGNEE_MCP_AUDIT_DIR"] = tmpDir;
  });

  afterEach(async () => {
    delete process.env["ASSIGNEE_MCP_AUDIT_DIR"];
    await fsp.rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("forwards currentResourceIndex + hydrated completedResources on compound fixture", async () => {
    const filePath = await stageFixture("compound-serverless-api.json", tmpDir);
    const checkpoint: PlanCheckpoint = await loadCheckpointFromPath(filePath);

    const { ctx, invokeCalls } = makeCapturingGraphContext();

    await executeAndAudit(
      ctx,
      checkpoint,
      filePath,
      { preflightPassed: true },
      () => "",
    );

    // Phase 1 invoke — the initial-state object is the first arg.
    expect(invokeCalls.length).toBeGreaterThan(0);
    const initialState = invokeCalls[0]![0] as Record<string, unknown>;

    expect(initialState["currentResourceIndex"]).toBe(3);
    const completed = initialState["completedResources"] as Array<
      Record<string, unknown>
    >;
    expect(completed).toHaveLength(3);
    expect(completed[0]).toMatchObject({
      resourceId: "iam-execution-role",
      resourceType: "AWS::IAM::Role",
      executionStatus: ExecutionStatus.SUCCESS,
    });
    expect(completed[0]?.["resourceArn"]).toContain("<ACCOUNT_ID>");
    expect(completed[0]?.["resourceArn"]).toContain(
      ":role/assignee-iam-execution-role",
    );

    // resourceQueue + other checkpoint fields still flow through.
    expect(initialState["resourceQueue"]).toBeDefined();
    expect(initialState["runId"]).toBe(checkpoint.runId);
  });

  it("omits resume fields on pre-Epic-92 compound checkpoint (single-lambda-scheduled)", async () => {
    const filePath = await stageFixture("single-lambda-scheduled.json", tmpDir);
    const checkpoint = await loadCheckpointFromPath(filePath);

    // Sanity — the loader defaulted to 0 / [] on a pre-Epic-92 shape.
    expect(checkpoint.currentResourceIndex).toBe(0);
    expect(checkpoint.completedResources).toEqual([]);

    const { ctx, invokeCalls } = makeCapturingGraphContext();

    await executeAndAudit(
      ctx,
      checkpoint,
      filePath,
      { preflightPassed: true },
      () => "",
    );

    const initialState = invokeCalls[0]![0] as Record<string, unknown>;

    // The two new keys MUST NOT appear — this is the byte-for-byte
    // backwards-compat invariant. Use `in` so we detect even
    // undefined-valued keys.
    expect("currentResourceIndex" in initialState).toBe(false);
    expect("completedResources" in initialState).toBe(false);

    // Pre-fix behaviour still intact.
    expect(initialState["resourceQueue"]).toBeDefined();
  });

  it("omits resume fields on pre-Epic-92 single-resource checkpoint (single-ec2-baseline)", async () => {
    const filePath = await stageFixture("single-ec2-baseline.json", tmpDir);
    const checkpoint = await loadCheckpointFromPath(filePath);

    const { ctx, invokeCalls } = makeCapturingGraphContext();

    await executeAndAudit(
      ctx,
      checkpoint,
      filePath,
      { preflightPassed: true },
      () => "",
    );

    const initialState = invokeCalls[0]![0] as Record<string, unknown>;

    expect("currentResourceIndex" in initialState).toBe(false);
    expect("completedResources" in initialState).toBe(false);
  });
});

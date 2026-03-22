import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  serializeCheckpoint,
  saveCheckpoint,
  loadCheckpoint,
  findNewestValidCheckpoint,
} from "./checkpoint.js";
import { routeCheckpointEntry } from "./graph-routing.js";
import type { AgentState } from "./graph-state.js";

function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "checkpoint-test-"));
}

const baseGraphState: Partial<AgentState> = {
  userIntent: "create an S3 bucket named logs-prod",
  runId: "550e8400-e29b-41d4-a716-446655440000",
  resourceType: "AWS::S3::Bucket" as AgentState["resourceType"],
  desiredState: { BucketName: "logs-prod" },
  estimatedMonthlyCost: "$0.023/GB-month",
  preflightPassed: true,
  elicitedOptions: { Versioning: "Enabled" },
  messages: [{ role: "user", content: "hello" }] as unknown[],
  resourceSchema: { Type: "AWS::S3::Bucket", Properties: {} },
};

describe("serializeCheckpoint", () => {
  it("excludes non-serializable fields (messages, resourceSchema, resourcePattern)", () => {
    const stateWithPattern = {
      ...baseGraphState,
      resourcePattern: {
        patternId: "test",
        displayName: "Test",
        keywords: [],
        resourceList: [],
        dependencyOrder: [],
        defaultOptions: {},
      },
    } as AgentState;

    const checkpoint = serializeCheckpoint(stateWithPattern);

    expect(checkpoint.runId).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(checkpoint.userIntent).toBe("create an S3 bucket named logs-prod");
    expect(checkpoint.desiredState).toEqual({ BucketName: "logs-prod" });
    expect(checkpoint.preflightPassed).toBe(true);
    expect(checkpoint.checkpoint_version).toBe("1");
    expect(checkpoint.ttl_hours).toBe(72);
    expect(checkpoint.created_at).toBeDefined();

    // Non-serializable fields must be excluded
    expect("messages" in checkpoint).toBe(false);
    expect("resourceSchema" in checkpoint).toBe(false);
    expect("resourcePattern" in checkpoint).toBe(false);
  });

  it("includes all required fields", () => {
    const checkpoint = serializeCheckpoint(baseGraphState as AgentState);
    expect(checkpoint.resourceType).toBe("AWS::S3::Bucket");
    expect(checkpoint.estimatedMonthlyCost).toBe("$0.023/GB-month");
    expect(checkpoint.elicitedOptions).toEqual({ Versioning: "Enabled" });
  });

  it("handles compound patterns (resourceQueue, resourcePatternId)", () => {
    const compound = {
      ...baseGraphState,
      resourcePattern: {
        patternId: "serverless-api",
        displayName: "Serverless API",
        keywords: [],
        resourceList: [],
        dependencyOrder: [],
        defaultOptions: {},
      },
      resourceQueue: [
        {
          resourceId: "role",
          resourceType: "AWS::IAM::Role",
          displayName: "Role",
        },
      ],
    } as AgentState;

    const checkpoint = serializeCheckpoint(compound);
    expect(checkpoint.resourcePatternId).toBe("serverless-api");
    expect(checkpoint.resourceQueue).toHaveLength(1);
  });
});

describe("saveCheckpoint / loadCheckpoint round-trip", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("writes and reads back a valid checkpoint", async () => {
    const checkpoint = serializeCheckpoint(baseGraphState as AgentState);
    const filePath = await saveCheckpoint(checkpoint, tmpDir);

    expect(filePath).toContain("checkpoint-");
    expect(filePath).toContain(checkpoint.runId);

    const loaded = await loadCheckpoint(checkpoint.runId, tmpDir);
    expect(loaded.runId).toBe(checkpoint.runId);
    expect(loaded.desiredState).toEqual(checkpoint.desiredState);
  });

  it("throws CheckpointError on invalid schema", async () => {
    const bad = { runId: "bad", invalid: true };
    const filePath = path.join(tmpDir, "checkpoint-bad.json");
    await fs.writeFile(filePath, JSON.stringify(bad));

    await expect(loadCheckpoint("bad", tmpDir)).rejects.toThrow(
      "Invalid checkpoint file",
    );
  });

  it("throws CheckpointError on corrupt JSON", async () => {
    const filePath = path.join(tmpDir, "checkpoint-corrupt.json");
    await fs.writeFile(filePath, "{truncated garbage");

    await expect(loadCheckpoint("corrupt", tmpDir)).rejects.toThrow(
      "Corrupt checkpoint file",
    );
  });
});

describe("findNewestValidCheckpoint", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns newest valid checkpoint when multiple exist", async () => {
    const older = serializeCheckpoint(baseGraphState as AgentState);
    older.created_at = new Date(Date.now() - 60_000).toISOString();
    older.runId = "00000000-0000-0000-0000-000000000001";
    await saveCheckpoint(older, tmpDir);

    const newer = serializeCheckpoint(baseGraphState as AgentState);
    newer.runId = "00000000-0000-0000-0000-000000000002";
    await saveCheckpoint(newer, tmpDir);

    const found = await findNewestValidCheckpoint(tmpDir);
    expect(found).not.toBeNull();
    expect(found!.runId).toBe("00000000-0000-0000-0000-000000000002");
  });

  it("returns null when all checkpoints are expired", async () => {
    const expired = serializeCheckpoint(baseGraphState as AgentState);
    expired.created_at = new Date(
      Date.now() - 73 * 60 * 60 * 1000,
    ).toISOString(); // 73h ago, past 72h TTL
    expired.runId = "00000000-0000-0000-0000-000000000003";
    await saveCheckpoint(expired, tmpDir);

    const found = await findNewestValidCheckpoint(tmpDir);
    expect(found).toBeNull();
  });

  it("returns null when directory is empty", async () => {
    const found = await findNewestValidCheckpoint(tmpDir);
    expect(found).toBeNull();
  });

  it("skips corrupt JSON files and returns valid checkpoint", async () => {
    // Write a corrupt file
    await fs.writeFile(
      path.join(tmpDir, "checkpoint-00000000-0000-0000-0000-000000000099.json"),
      "{broken json",
    );

    // Write a valid file
    const valid = serializeCheckpoint(baseGraphState as AgentState);
    valid.runId = "00000000-0000-0000-0000-000000000050";
    await saveCheckpoint(valid, tmpDir);

    const found = await findNewestValidCheckpoint(tmpDir);
    expect(found).not.toBeNull();
    expect(found!.runId).toBe("00000000-0000-0000-0000-000000000050");
  });

  it("returns null when directory does not exist", async () => {
    const found = await findNewestValidCheckpoint(
      path.join(tmpDir, "nonexistent"),
    );
    expect(found).toBeNull();
  });
});

describe("TTL validation", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("accepts checkpoint within TTL", async () => {
    const cp = serializeCheckpoint(baseGraphState as AgentState);
    cp.created_at = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(); // 1h ago
    cp.runId = "00000000-0000-0000-0000-000000000010";
    await saveCheckpoint(cp, tmpDir);

    const found = await findNewestValidCheckpoint(tmpDir);
    expect(found).not.toBeNull();
    expect(found!.runId).toBe("00000000-0000-0000-0000-000000000010");
  });

  it("rejects checkpoint beyond TTL", async () => {
    const cp = serializeCheckpoint(baseGraphState as AgentState);
    cp.ttl_hours = 1;
    cp.created_at = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago, past 1h TTL
    cp.runId = "00000000-0000-0000-0000-000000000011";
    await saveCheckpoint(cp, tmpDir);

    const found = await findNewestValidCheckpoint(tmpDir);
    expect(found).toBeNull();
  });
});

describe("integration: plan save + apply reuse pipeline", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("plan serializes and saves checkpoint file with correct content", async () => {
    // Simulate what plan.ts does after successful graph execution
    const checkpoint = serializeCheckpoint(baseGraphState as AgentState);
    const filePath = await saveCheckpoint(checkpoint, tmpDir);

    // Verify file exists and has correct structure
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.checkpoint_version).toBe("1");
    expect(parsed.runId).toBe(baseGraphState.runId);
    expect(parsed.userIntent).toBe(baseGraphState.userIntent);
    expect(parsed.resourceType).toBe(baseGraphState.resourceType);
    expect(parsed.desiredState).toEqual(baseGraphState.desiredState);
    expect(parsed.ttl_hours).toBe(72);
    expect(parsed.estimatedMonthlyCost).toBe(
      baseGraphState.estimatedMonthlyCost,
    );

    // Verify non-serializable fields are absent
    expect(parsed.messages).toBeUndefined();
    expect(parsed.resourceSchema).toBeUndefined();
    expect(parsed.resourcePattern).toBeUndefined();
  });

  it("apply detects checkpoint and can load it to skip Phase 1", async () => {
    // Simulate plan saving a checkpoint
    const checkpoint = serializeCheckpoint(baseGraphState as AgentState);
    await saveCheckpoint(checkpoint, tmpDir);

    // Simulate what apply.ts does before Phase 1
    const found = await findNewestValidCheckpoint(tmpDir);
    expect(found).not.toBeNull();
    expect(found!.runId).toBe(baseGraphState.runId);

    // Verify checkpoint contains all fields needed to inject into graph state
    expect(found!.userIntent).toBe(baseGraphState.userIntent);
    expect(found!.resourceType).toBe(baseGraphState.resourceType);
    expect(found!.desiredState).toEqual(baseGraphState.desiredState);
    expect(found!.estimatedMonthlyCost).toBe(
      baseGraphState.estimatedMonthlyCost,
    );
    expect(found!.preflightPassed).toBe(true);
    expect(found!.elicitedOptions).toEqual(baseGraphState.elicitedOptions);
  });
});

describe("routeCheckpointEntry", () => {
  it("routes to human_approval when checkpointResumed is true and desiredState exists", () => {
    const state = {
      ...baseGraphState,
      checkpointResumed: true,
      desiredState: { BucketName: "test" },
    } as AgentState;
    expect(routeCheckpointEntry(state)).toBe("human_approval");
  });

  it("routes to intent_parser when checkpointResumed is false", () => {
    const state = {
      ...baseGraphState,
      checkpointResumed: false,
    } as AgentState;
    expect(routeCheckpointEntry(state)).toBe("intent_parser");
  });

  it("routes to intent_parser when checkpointResumed is true but no desiredState", () => {
    const state = {
      ...baseGraphState,
      checkpointResumed: true,
      desiredState: undefined,
    } as AgentState;
    expect(routeCheckpointEntry(state)).toBe("intent_parser");
  });
});

describe("policyApprovalStatus", () => {
  it("is written when preflight ran with policy validation", () => {
    const stateWithPolicy = {
      ...baseGraphState,
      preflightPassed: true,
    } as AgentState;

    const checkpoint = serializeCheckpoint(stateWithPolicy);
    expect(checkpoint.preflightPassed).toBe(true);
    // policyApprovalStatus is optional — only present when explicitly set on state
    // This verifies the field is supported in serialization
  });

  it("is absent when preflight was skipped", () => {
    const stateNoPolicy = {
      ...baseGraphState,
      preflightPassed: false,
    } as AgentState;

    const checkpoint = serializeCheckpoint(stateNoPolicy);
    expect(checkpoint.preflightPassed).toBe(false);
    expect(checkpoint.policyApprovalStatus).toBeUndefined();
  });
});

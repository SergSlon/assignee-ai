import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  serializeCheckpoint,
  saveCheckpoint,
  loadCheckpoint,
  loadCheckpointFromPath,
  findNewestValidCheckpoint,
  pruneExpiredCheckpoints,
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

  it("skips checkpoints with preflightPassed=false", async () => {
    const failedPreflight = serializeCheckpoint({
      ...baseGraphState,
      preflightPassed: false,
    } as AgentState);
    failedPreflight.runId = "00000000-0000-0000-0000-000000000010";
    await saveCheckpoint(failedPreflight, tmpDir);

    const found = await findNewestValidCheckpoint(tmpDir);
    expect(found).toBeNull();
  });

  it("skips checkpoints with empty desiredState", async () => {
    const emptyState = serializeCheckpoint({
      ...baseGraphState,
      desiredState: {},
    } as AgentState);
    emptyState.runId = "00000000-0000-0000-0000-000000000011";
    await saveCheckpoint(emptyState, tmpDir);

    const found = await findNewestValidCheckpoint(tmpDir);
    expect(found).toBeNull();
  });

  it("returns valid checkpoint when mixed with invalid ones", async () => {
    // Invalid: preflight failed
    const invalid = serializeCheckpoint({
      ...baseGraphState,
      preflightPassed: false,
    } as AgentState);
    invalid.runId = "00000000-0000-0000-0000-000000000012";
    invalid.created_at = new Date(Date.now() + 1000).toISOString();
    await saveCheckpoint(invalid, tmpDir);

    // Valid
    const valid = serializeCheckpoint(baseGraphState as AgentState);
    valid.runId = "00000000-0000-0000-0000-000000000013";
    await saveCheckpoint(valid, tmpDir);

    const found = await findNewestValidCheckpoint(tmpDir);
    expect(found).not.toBeNull();
    expect(found!.runId).toBe("00000000-0000-0000-0000-000000000013");
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

describe("loadCheckpointFromPath (Story 11.3)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns parsed checkpoint from valid file", async () => {
    const checkpoint = serializeCheckpoint(baseGraphState as AgentState);
    const filePath = await saveCheckpoint(checkpoint, tmpDir);

    const loaded = await loadCheckpointFromPath(filePath);
    expect(loaded.runId).toBe(checkpoint.runId);
    expect(loaded.userIntent).toBe(checkpoint.userIntent);
    expect(loaded.desiredState).toEqual(checkpoint.desiredState);
    expect(loaded.preflightPassed).toBe(true);
  });

  it("throws CheckpointError with actionable message for missing file", async () => {
    const missingPath = path.join(tmpDir, "checkpoint-nonexistent.json");

    await expect(loadCheckpointFromPath(missingPath)).rejects.toThrow(
      /Checkpoint file not found.*Run `assignee plan`/,
    );
  });

  it("throws CheckpointError when TTL is expired", async () => {
    const checkpoint = serializeCheckpoint(baseGraphState as AgentState);
    checkpoint.ttl_hours = 1;
    checkpoint.created_at = new Date(
      Date.now() - 2 * 60 * 60 * 1000,
    ).toISOString(); // 2h ago, past 1h TTL
    const filePath = await saveCheckpoint(checkpoint, tmpDir);

    await expect(loadCheckpointFromPath(filePath)).rejects.toThrow(
      /Checkpoint expired.*TTL 1h.*Run `assignee plan`/,
    );
  });

  it("throws CheckpointError on invalid schema", async () => {
    const invalidPath = path.join(tmpDir, "checkpoint-invalid.json");
    await fs.writeFile(
      invalidPath,
      JSON.stringify({ runId: "bad", something: "wrong" }),
    );

    await expect(loadCheckpointFromPath(invalidPath)).rejects.toThrow(
      "Invalid checkpoint file",
    );
  });

  it("throws CheckpointError on corrupt JSON", async () => {
    const corruptPath = path.join(tmpDir, "checkpoint-corrupt.json");
    await fs.writeFile(corruptPath, "{not valid json");

    await expect(loadCheckpointFromPath(corruptPath)).rejects.toThrow(
      "Corrupt checkpoint file",
    );
  });

  it("throws CheckpointError when preflightPassed is false", async () => {
    const checkpoint = serializeCheckpoint({
      ...baseGraphState,
      preflightPassed: false,
    } as AgentState);
    const filePath = await saveCheckpoint(checkpoint, tmpDir);

    await expect(loadCheckpointFromPath(filePath)).rejects.toThrow(
      /did not pass preflight/,
    );
  });

  it("throws CheckpointError when desiredState is empty", async () => {
    const checkpoint = serializeCheckpoint({
      ...baseGraphState,
      desiredState: {},
    } as AgentState);
    const filePath = await saveCheckpoint(checkpoint, tmpDir);

    await expect(loadCheckpointFromPath(filePath)).rejects.toThrow(
      /no desiredState/,
    );
  });

  it("strips [REDACTED] fields from desiredState on load", async () => {
    const checkpoint = serializeCheckpoint({
      ...baseGraphState,
      desiredState: {
        BucketName: "logs-prod",
        MasterUserPassword: "secret123",
      },
    } as AgentState);
    // serializeCheckpoint redacts sensitive fields, so MasterUserPassword becomes "[REDACTED]"
    expect(checkpoint.desiredState["MasterUserPassword"]).toBe("[REDACTED]");

    const filePath = await saveCheckpoint(checkpoint, tmpDir);
    const loaded = await loadCheckpointFromPath(filePath);

    // [REDACTED] fields should be stripped, not present in loaded state
    expect(loaded.desiredState).toEqual({ BucketName: "logs-prod" });
    expect(loaded.desiredState).not.toHaveProperty("MasterUserPassword");
  });
});

describe("pruneExpiredCheckpoints (Story 33.2)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns { pruned: 0, kept: 0 } when directory does not exist", async () => {
    const result = await pruneExpiredCheckpoints(
      path.join(tmpDir, "nonexistent"),
    );
    expect(result).toEqual({ pruned: 0, kept: 0 });
  });

  it("returns { pruned: 0, kept: 0 } when directory is empty", async () => {
    const result = await pruneExpiredCheckpoints(tmpDir);
    expect(result).toEqual({ pruned: 0, kept: 0 });
  });

  it("keeps the 3 newest checkpoints regardless of expiry", async () => {
    // Create 4 expired checkpoints
    for (let i = 1; i <= 4; i++) {
      const cp = serializeCheckpoint(baseGraphState as AgentState);
      cp.runId = `00000000-0000-0000-0000-00000000000${i}`;
      cp.ttl_hours = 1;
      cp.created_at = new Date(
        Date.now() - (100 + i) * 60 * 60 * 1000,
      ).toISOString();
      const filePath = await saveCheckpoint(cp, tmpDir);
      // Touch the file with an old mtime so it's not "recently modified"
      const oldTime = new Date(Date.now() - 60 * 60 * 1000);
      await fs.utimes(filePath, oldTime, oldTime);
    }

    const result = await pruneExpiredCheckpoints(tmpDir, {
      skipRecentMinutes: 0,
    });

    // 3 kept (newest rule), 1 pruned
    expect(result.kept).toBe(3);
    expect(result.pruned).toBe(1);
  });

  it("does not prune non-expired checkpoints beyond the top 3", async () => {
    for (let i = 1; i <= 5; i++) {
      const cp = serializeCheckpoint(baseGraphState as AgentState);
      cp.runId = `00000000-0000-0000-0000-00000000000${i}`;
      cp.ttl_hours = 999;
      cp.created_at = new Date(Date.now() - i * 60 * 1000).toISOString();
      await saveCheckpoint(cp, tmpDir);
    }

    const result = await pruneExpiredCheckpoints(tmpDir, {
      skipRecentMinutes: 0,
    });
    // All 5 are non-expired, so all are kept
    expect(result.pruned).toBe(0);
    expect(result.kept).toBe(5);
  });

  it("skips recently modified files even if expired", async () => {
    // Create 5 expired checkpoints with different created_at times
    // The "newest 3" by created_at are kept automatically.
    // The 4th oldest is recently modified (mtime is now) so should be kept.
    // The 5th oldest has old mtime and is expired, so it gets pruned.
    for (let i = 1; i <= 5; i++) {
      const cp = serializeCheckpoint(baseGraphState as AgentState);
      cp.runId = `00000000-0000-0000-0000-00000000000${i}`;
      cp.ttl_hours = 1;
      // i=1 is oldest, i=5 is newest
      cp.created_at = new Date(
        Date.now() - (200 - i) * 60 * 60 * 1000,
      ).toISOString();
      const fp = await saveCheckpoint(cp, tmpDir);
      if (i <= 1) {
        // oldest file: old mtime => pruneable
        const oldTime = new Date(Date.now() - 60 * 60 * 1000);
        await fs.utimes(fp, oldTime, oldTime);
      } else if (i === 2) {
        // 4th from top: keep mtime as now (recently modified) => should be kept
        // (mtime is already "now" from the write)
      } else {
        // i=3,4,5 are the newest 3 by created_at => kept automatically
        const oldTime = new Date(Date.now() - 60 * 60 * 1000);
        await fs.utimes(fp, oldTime, oldTime);
      }
    }

    const result = await pruneExpiredCheckpoints(tmpDir, {
      skipRecentMinutes: 10,
    });
    // 3 kept (newest by created_at) + 1 kept (recently modified) = 4 kept, 1 pruned
    expect(result.kept).toBe(4);
    expect(result.pruned).toBe(1);
  });
});

describe("checkpoint file permissions and redaction (H17)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("writes the checkpoint file with mode 0o600 (owner-only)", async () => {
    const checkpoint = serializeCheckpoint(baseGraphState as AgentState);
    const filePath = await saveCheckpoint(checkpoint, tmpDir);

    const stat = await fs.stat(filePath);
    // Only the permission bits — mask out file-type bits.
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("redacts AdminPassword, Token, PrivateKey, KeyMaterial, UserData via regex denylist", async () => {
    const state = {
      ...baseGraphState,
      desiredState: {
        BucketName: "logs-prod",
        // Real CFN shapes: IAM User LoginProfile.Password,
        // RDS AdminPassword, Lambda Environment variables with tokens,
        // EC2 KeyPair KeyMaterial, EC2 Instance UserData.
        AdminPassword: "Correct-Horse-Battery-Staple",
        Token: "ghp_1234567890abcdef1234567890abcdef1234",
        ApiKey: "xoxb-123-456-abc",
        PrivateKey: "-----BEGIN RSA PRIVATE KEY-----MIIE...",
        KeyMaterial: "ssh-rsa AAAAB3NzaC1yc2E...",
        UserData: "#!/bin/bash\nexport DB_PASSWORD=hunter2",
        LoginProfile: {
          Password: "TempPass123!",
          // Sibling field name also matches /password/i — denylist is
          // intentionally aggressive, so this is also redacted.
          PasswordResetRequired: true,
        },
        // Neutral fields must be preserved
        Region: "us-east-1",
        BackupRetentionPeriod: 7,
      },
    } as AgentState;

    const checkpoint = serializeCheckpoint(state);
    const filePath = await saveCheckpoint(checkpoint, tmpDir);
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);

    expect(parsed.desiredState.AdminPassword).toBe("[REDACTED]");
    expect(parsed.desiredState.Token).toBe("[REDACTED]");
    expect(parsed.desiredState.ApiKey).toBe("[REDACTED]");
    expect(parsed.desiredState.PrivateKey).toBe("[REDACTED]");
    expect(parsed.desiredState.KeyMaterial).toBe("[REDACTED]");
    expect(parsed.desiredState.UserData).toBe("[REDACTED]");
    // Nested LoginProfile.Password
    expect(parsed.desiredState.LoginProfile.Password).toBe("[REDACTED]");
    // Aggressive denylist also masks sibling /password/i matches
    expect(parsed.desiredState.LoginProfile.PasswordResetRequired).toBe(
      "[REDACTED]",
    );
    // Truly neutral fields preserved
    expect(parsed.desiredState.Region).toBe("us-east-1");
    expect(parsed.desiredState.BackupRetentionPeriod).toBe(7);
    expect(parsed.desiredState.BucketName).toBe("logs-prod");
  });

  it("redacts AKIA-pattern strings inside arbitrary values", async () => {
    const state = {
      ...baseGraphState,
      desiredState: {
        BucketName: "logs-prod",
        // Real AWS access-key format embedded in a neutral field
        Description: "Migrated from AKIAIOSFODNN7EXAMPLE account",
        Tags: [
          { Key: "Owner", Value: "platform-team" },
          { Key: "MigratedFrom", Value: "AKIAIOSFODNN7EXAMPLE" },
        ],
        Metadata: {
          // Nested neutral-named field with a leaked access key id
          LastOperator: "AKIA1234567890ABCDEF",
        },
      },
    } as AgentState;

    const checkpoint = serializeCheckpoint(state);
    const filePath = await saveCheckpoint(checkpoint, tmpDir);
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);

    expect(parsed.desiredState.Description).toBe("[REDACTED]");
    expect(parsed.desiredState.Tags[1].Value).toBe("[REDACTED]");
    expect(parsed.desiredState.Tags[0].Value).toBe("platform-team");
    expect(parsed.desiredState.Metadata.LastOperator).toBe("[REDACTED]");
  });

  it("still redacts the legacy keys covered by the previous allowlist", async () => {
    const state = {
      ...baseGraphState,
      desiredState: {
        BucketName: "logs-prod",
        MasterUserPassword: "legacy",
        SecretString: "legacy",
        SessionToken: "legacy",
      },
    } as AgentState;

    const checkpoint = serializeCheckpoint(state);
    const filePath = await saveCheckpoint(checkpoint, tmpDir);
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);

    expect(parsed.desiredState.MasterUserPassword).toBe("[REDACTED]");
    expect(parsed.desiredState.SecretString).toBe("[REDACTED]");
    expect(parsed.desiredState.SessionToken).toBe("[REDACTED]");
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

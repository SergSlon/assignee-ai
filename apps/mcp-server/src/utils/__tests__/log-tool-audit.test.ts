/**
 * Unit tests for the shared MCP tool audit helper.
 *
 * Backlog cleanup story C: this helper backs both `logApplyAudit`
 * (apply_plan) and `logDestroyAudit` (destroy_resource). The two
 * tool-specific wrappers are now thin adapters that forward to
 * `logToolAudit`; if this writer regresses, both tools' audit trails
 * regress together. These tests pin the on-disk JSONL shape with
 * realistic data drawn from each tool's actual call-sites so a
 * future edit to the helper surfaces the change immediately.
 *
 * The underlying `auditLog` writer appends to a file under
 * `ASSIGNEE_MCP_AUDIT_DIR` — override that with a tmp dir per test so
 * we exercise the real writer (file I/O is fast, and mocking fs in
 * ESM hoisting order is fragile).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { logToolAudit } from "../log-tool-audit.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "log-tool-audit-"));
  process.env["ASSIGNEE_MCP_AUDIT_DIR"] = tmpDir;
});

afterEach(async () => {
  delete process.env["ASSIGNEE_MCP_AUDIT_DIR"];
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function readSingleRecord(): Promise<Record<string, unknown>> {
  const files = (await fs.readdir(tmpDir)).filter((f) =>
    f.startsWith("mcp-audit-"),
  );
  expect(files).toHaveLength(1);
  const contents = await fs.readFile(path.join(tmpDir, files[0]!), "utf-8");
  const lines = contents.trim().split("\n").filter(Boolean);
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!);
}

describe("logToolAudit", () => {
  it("writes a success record with the apply_plan tool name and the real runId/ARN", async () => {
    // Realistic apply_plan success data drawn from the existing
    // apply-plan/audit.test.ts fixtures.
    await logToolAudit(
      {
        tool: "apply_plan",
        runId: "11111111-1111-1111-1111-111111111111",
        resourceType: "AWS::S3::Bucket",
        identifier: "arn:aws:s3:::my-real-bucket",
      },
      { kind: "success" },
    );
    const record = await readSingleRecord();
    expect(record["tool"]).toBe("apply_plan");
    expect(record["runId"]).toBe("11111111-1111-1111-1111-111111111111");
    expect(record["resourceType"]).toBe("AWS::S3::Bucket");
    expect(record["identifier"]).toBe("arn:aws:s3:::my-real-bucket");
    expect(record["success"]).toBe(true);
    expect(record["errorClass"]).toBe("");
    expect(typeof record["timestamp"]).toBe("string");
    // Pin the on-disk schema to exactly the Story 50-5 H-3 surface
    // — adding fields here is a deliberate downstream-breaking change.
    expect(Object.keys(record).sort()).toEqual(
      [
        "errorClass",
        "identifier",
        "resourceType",
        "runId",
        "success",
        "timestamp",
        "tool",
      ].sort(),
    );
  });

  it("writes a success record with the destroy_resource tool name and an empty runId", async () => {
    // Realistic destroy_resource success data — destroy has no
    // checkpoint so runId is the Story 50-5 H-3 empty-string sentinel.
    await logToolAudit(
      {
        tool: "destroy_resource",
        runId: "",
        resourceType: "AWS::Lambda::Function",
        identifier: "arn:aws:lambda:us-east-1:111122223333:function:my-fn",
      },
      { kind: "success" },
    );
    const record = await readSingleRecord();
    expect(record["tool"]).toBe("destroy_resource");
    expect(record["runId"]).toBe("");
    expect(record["resourceType"]).toBe("AWS::Lambda::Function");
    expect(record["identifier"]).toBe(
      "arn:aws:lambda:us-east-1:111122223333:function:my-fn",
    );
    expect(record["success"]).toBe(true);
    expect(record["errorClass"]).toBe("");
  });

  it("writes a failure record with the provided errorClass classification", async () => {
    await logToolAudit(
      {
        tool: "apply_plan",
        runId: "22222222-2222-2222-2222-222222222222",
        resourceType: "AWS::Lambda::Function",
        identifier: "/tmp/assignee-mcp-checkpoints/cp.json",
      },
      { kind: "failure", errorClass: "BpBlocked" },
    );
    const record = await readSingleRecord();
    expect(record["tool"]).toBe("apply_plan");
    expect(record["success"]).toBe(false);
    expect(record["errorClass"]).toBe("BpBlocked");
    expect(record["identifier"]).toBe("/tmp/assignee-mcp-checkpoints/cp.json");
  });

  it("honours every classification both tools emit, none containing a raw message delimiter", async () => {
    // Union of the classifications the apply_plan and destroy_resource
    // handlers route through their audit helpers — exercises the
    // shared writer against the full classification surface so a
    // regression in either tool's allowlist contract surfaces here.
    const classifications = [
      // apply_plan
      "CheckpointError",
      "UnknownError",
      "ApplyAlreadyActive",
      "BpBlocked",
      "BpEvaluationError",
      "GraphExecutionError",
      // destroy_resource
      "NoRequestToken",
      "PollFailure",
      "CrossAccountNotFound",
      "DestroyError",
      "ResourceNotFoundException",
    ];
    for (const errorClass of classifications) {
      const iterDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "log-tool-audit-iter-"),
      );
      process.env["ASSIGNEE_MCP_AUDIT_DIR"] = iterDir;
      try {
        await logToolAudit(
          {
            tool: "apply_plan",
            runId: "",
            resourceType: "AWS::S3::Bucket",
            identifier: "arn:aws:s3:::audit-fixture",
          },
          { kind: "failure", errorClass },
        );
        const files = (await fs.readdir(iterDir)).filter((f) =>
          f.startsWith("mcp-audit-"),
        );
        const contents = await fs.readFile(
          path.join(iterDir, files[0]!),
          "utf-8",
        );
        const record = JSON.parse(contents.trim()) as Record<string, unknown>;
        expect(record["success"]).toBe(false);
        expect(record["errorClass"]).toBe(errorClass);
        // Sanity check: classifications must never contain a colon
        // (which would signal a leaked SDK error message like
        // "AccessDeniedException: user not authorized"). Enforces the
        // feedback_redaction_allowlist_not_denylist invariant at the
        // classification layer.
        expect(String(record["errorClass"])).not.toContain(":");
      } finally {
        await fs.rm(iterDir, { recursive: true, force: true });
      }
    }
    process.env["ASSIGNEE_MCP_AUDIT_DIR"] = tmpDir;
  });

  it("does not persist tool-specific extras on the outcome (preserves the six-field schema)", async () => {
    // Callers may attach extras for future structured-log sinks; the
    // persistent JSONL audit trail must remain the stable six-field
    // shape so existing parsers don't break. This test pins that
    // contract.
    await logToolAudit(
      {
        tool: "apply_plan",
        runId: "77777777-7777-7777-7777-777777777777",
        resourceType: "AWS::S3::Bucket",
        identifier: "arn:aws:s3:::extras-test",
      },
      {
        kind: "failure",
        errorClass: "BpEvaluationError",
        extras: {
          phase: "bp-revaluation",
          concurrencyCap: 4,
          findingCount: 3,
        },
      },
    );
    const record = await readSingleRecord();
    expect(record["errorClass"]).toBe("BpEvaluationError");
    // Extras intentionally absent from the persistent record.
    expect(record).not.toHaveProperty("phase");
    expect(record).not.toHaveProperty("concurrencyCap");
    expect(record).not.toHaveProperty("findingCount");
    expect(record).not.toHaveProperty("extras");
  });

  it("does not throw when the audit writer fails (best-effort contract)", async () => {
    // Point the audit dir at a path whose parent is a FILE (not a dir),
    // so fs.mkdir + fs.appendFile both fail. The helper must swallow
    // the failure per the audit-log module contract.
    const blocker = path.join(tmpDir, "blocker-file");
    await fs.writeFile(blocker, "not a directory");
    process.env["ASSIGNEE_MCP_AUDIT_DIR"] = path.join(
      blocker,
      "cannot-create-here",
    );
    await expect(
      logToolAudit(
        {
          tool: "destroy_resource",
          runId: "",
          resourceType: "AWS::S3::Bucket",
          identifier: "arn:aws:s3:::enospc",
        },
        { kind: "failure", errorClass: "PollFailure" },
      ),
    ).resolves.toBeUndefined();
    process.env["ASSIGNEE_MCP_AUDIT_DIR"] = tmpDir;
  });
});

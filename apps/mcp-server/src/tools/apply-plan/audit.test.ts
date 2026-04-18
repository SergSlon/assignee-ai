/**
 * Unit tests for the apply-plan audit helper (Story 54-it1-08).
 *
 * The helper consolidates the four duplicated `auditLog({...})` call-
 * sites in the pre-refactor handler (CheckpointError /
 * ApplyAlreadyActive / BpBlocked / BpEvaluationError) plus the
 * terminal GraphExecutionError path into a single discriminated-
 * outcome surface, and provides a `failWithAudit` reducer that binds
 * the audit write to a `StepResult<never>` done-response.
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

import { failWithAudit, logApplyAudit } from "./audit.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "apply-audit-"));
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

describe("logApplyAudit", () => {
  it("writes a success record with empty errorClass and the resolved ARN", async () => {
    await logApplyAudit(
      {
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
  });

  it("writes a failure record with the provided classification", async () => {
    await logApplyAudit(
      {
        runId: "22222222-2222-2222-2222-222222222222",
        resourceType: "AWS::Lambda::Function",
        identifier: "/tmp/assignee-mcp-checkpoints/cp.json",
      },
      { kind: "failure", errorClass: "BpBlocked" },
    );
    const record = await readSingleRecord();
    expect(record["success"]).toBe(false);
    expect(record["errorClass"]).toBe("BpBlocked");
    expect(record["identifier"]).toBe("/tmp/assignee-mcp-checkpoints/cp.json");
  });

  it("accepts every errorClass the handler emits, none contain a raw message delimiter", async () => {
    // The handler routes through failWithAudit for CheckpointError /
    // ApplyAlreadyActive / BpBlocked / BpEvaluationError, and direct
    // logApplyAudit for GraphExecutionError on the terminal path.
    const classifications = [
      "CheckpointError",
      "UnknownError",
      "ApplyAlreadyActive",
      "BpBlocked",
      "BpEvaluationError",
      "GraphExecutionError",
    ];
    for (const errorClass of classifications) {
      const iterDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "apply-audit-iter-"),
      );
      process.env["ASSIGNEE_MCP_AUDIT_DIR"] = iterDir;
      try {
        await logApplyAudit(
          {
            runId: "",
            resourceType: "AWS::S3::Bucket",
            identifier: "/tmp/cp.json",
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
        // "CheckpointError: invalid schema"). Enforces the
        // feedback_redaction_allowlist_not_denylist invariant at the
        // classification layer.
        expect(String(record["errorClass"])).not.toContain(":");
      } finally {
        await fs.rm(iterDir, { recursive: true, force: true });
      }
    }
    process.env["ASSIGNEE_MCP_AUDIT_DIR"] = tmpDir;
  });

  it("does not throw when the audit writer fails (best-effort contract)", async () => {
    const blocker = path.join(tmpDir, "blocker-file");
    await fs.writeFile(blocker, "not a directory");
    process.env["ASSIGNEE_MCP_AUDIT_DIR"] = path.join(
      blocker,
      "cannot-create-here",
    );
    await expect(
      logApplyAudit(
        {
          runId: "33333333-3333-3333-3333-333333333333",
          resourceType: "AWS::S3::Bucket",
          identifier: "/tmp/cp.json",
        },
        { kind: "failure", errorClass: "GraphExecutionError" },
      ),
    ).resolves.toBeUndefined();
    process.env["ASSIGNEE_MCP_AUDIT_DIR"] = tmpDir;
  });
});

describe("failWithAudit", () => {
  it("emits a failure record and returns a done StepResult wrapping the supplied envelope", async () => {
    const ctx = {
      runId: "44444444-4444-4444-4444-444444444444",
      resourceType: "AWS::S3::Bucket",
      identifier: "/tmp/already-active.json",
    };
    const result = await failWithAudit(ctx, "ApplyAlreadyActive", {
      message: "This plan is already being applied.",
    });

    expect(result.kind).toBe("done");
    if (result.kind !== "done") return; // type narrowing
    const text = result.response.content[0]?.text ?? "";
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(body["error"]).toBe(true);
    expect(body["message"]).toBe("This plan is already being applied.");
    expect(result.response.isError).toBe(true);

    const record = await readSingleRecord();
    expect(record["errorClass"]).toBe("ApplyAlreadyActive");
    expect(record["success"]).toBe(false);
    expect(record["runId"]).toBe(ctx.runId);
    expect(record["identifier"]).toBe(ctx.identifier);
  });

  it("includes the hint field when one is supplied", async () => {
    const ctx = {
      runId: "55555555-5555-5555-5555-555555555555",
      resourceType: "AWS::EC2::Instance",
      identifier: "/tmp/bp-eval-error.json",
    };
    const result = await failWithAudit(ctx, "BpEvaluationError", {
      message: "BP evaluation failed.",
      hint: "Run plan_resource again.",
    });

    expect(result.kind).toBe("done");
    if (result.kind !== "done") return;
    const body = JSON.parse(result.response.content[0]?.text ?? "") as Record<
      string,
      unknown
    >;
    expect(body["hint"]).toBe("Run plan_resource again.");
  });

  it("passes through a pre-built ToolEnvelope unchanged (used by BpBlocked path)", async () => {
    const ctx = {
      runId: "66666666-6666-6666-6666-666666666666",
      resourceType: "AWS::S3::Bucket",
      identifier: "/tmp/bp-blocked.json",
    };
    const prebuilt = {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            error: true,
            message: "BP re-evaluation blocked apply.",
            blockingFindings: [
              {
                practiceId: "s3-block-public-access",
                title: "S3 buckets must block public access",
                severity: "HIGH",
                message: "Public access is enabled.",
                remediation: "Enable Block Public Access.",
                consequence: "Exposes data to the internet.",
              },
            ],
          }),
        },
      ],
      isError: true,
    };
    const result = await failWithAudit(ctx, "BpBlocked", prebuilt);

    expect(result.kind).toBe("done");
    if (result.kind !== "done") return;
    // The reducer must pass the pre-built envelope through untouched
    // so the blockingFindings payload reaches the MCP client.
    expect(result.response).toBe(prebuilt);

    const record = await readSingleRecord();
    expect(record["errorClass"]).toBe("BpBlocked");
  });
});

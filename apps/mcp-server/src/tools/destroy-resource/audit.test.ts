/**
 * Unit tests for the destroy-resource audit helper (Story 53-it1-09).
 *
 * The helper consolidates the 5 previously-duplicated `auditLog({...})`
 * call-sites in the tool entrypoint into one discriminated-outcome
 * surface. These tests exercise both the success and failure variants
 * and pin the resulting JSONL record shape so a future edit to the
 * schema surfaces immediately.
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

import { logDestroyAudit } from "./audit.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "destroy-audit-"));
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

describe("logDestroyAudit", () => {
  it("writes a success record with empty errorClass and the real ARN", async () => {
    await logDestroyAudit(
      {
        arn: "arn:aws:s3:::my-real-bucket",
        resourceType: "AWS::S3::Bucket",
      },
      { kind: "success" },
    );
    const record = await readSingleRecord();
    expect(record["tool"]).toBe("destroy_resource");
    expect(record["runId"]).toBe("");
    expect(record["resourceType"]).toBe("AWS::S3::Bucket");
    expect(record["identifier"]).toBe("arn:aws:s3:::my-real-bucket");
    expect(record["success"]).toBe(true);
    expect(record["errorClass"]).toBe("");
    expect(typeof record["timestamp"]).toBe("string");
  });

  it("writes a failure record with the provided errorClass classification", async () => {
    await logDestroyAudit(
      {
        arn: "arn:aws:lambda:us-east-1:111122223333:function:my-fn",
        resourceType: "AWS::Lambda::Function",
      },
      { kind: "failure", errorClass: "ResourceNotFoundException" },
    );
    const record = await readSingleRecord();
    expect(record["tool"]).toBe("destroy_resource");
    expect(record["success"]).toBe(false);
    expect(record["errorClass"]).toBe("ResourceNotFoundException");
    // Full ARN is the audit identifier — never the bare name.
    expect(record["identifier"]).toBe(
      "arn:aws:lambda:us-east-1:111122223333:function:my-fn",
    );
  });

  it("honours every kebab-case errorClass used by the handler for transient outcomes", async () => {
    // The handler calls this for the NoRequestToken / PollFailure /
    // CrossAccountNotFound / DestroyError paths — verify each maps
    // to a short classification string, not a raw error message.
    const classifications = [
      "NoRequestToken",
      "PollFailure",
      "CrossAccountNotFound",
      "DestroyError",
    ];
    for (const errorClass of classifications) {
      // Fresh tmp dir per iteration so readSingleRecord sees one line.
      const iterDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "destroy-audit-iter-"),
      );
      process.env["ASSIGNEE_MCP_AUDIT_DIR"] = iterDir;
      try {
        await logDestroyAudit(
          {
            arn: "arn:aws:s3:::audit-fixture",
            resourceType: "AWS::S3::Bucket",
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
        // "AccessDeniedException: user not authorized").
        expect(String(record["errorClass"])).not.toContain(":");
      } finally {
        await fs.rm(iterDir, { recursive: true, force: true });
      }
    }
    // Restore the outer-test tmp dir pointer so afterEach cleanup works.
    process.env["ASSIGNEE_MCP_AUDIT_DIR"] = tmpDir;
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
      logDestroyAudit(
        { arn: "arn:aws:s3:::enospc", resourceType: "AWS::S3::Bucket" },
        { kind: "failure", errorClass: "PollFailure" },
      ),
    ).resolves.toBeUndefined();
    // Restore for afterEach cleanup.
    process.env["ASSIGNEE_MCP_AUDIT_DIR"] = tmpDir;
  });
});

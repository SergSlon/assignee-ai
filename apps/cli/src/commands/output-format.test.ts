/**
 * Unit tests for output-format helpers.
 *
 * Covers resolveJsonMode (pre-existing) and redactAccountIdIfDemoMode (BUG-2).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveJsonMode, redactAccountIdIfDemoMode } from "./output-format.js";

// ── resolveJsonMode ──────────────────────────────────────────────────────────

describe("resolveJsonMode", () => {
  it("returns true when output is explicitly 'json'", () => {
    const opts = { output: "json" };
    expect(resolveJsonMode(opts)).toBe(true);
  });

  it("returns false when output is 'text'", () => {
    const opts = { output: "text" };
    expect(resolveJsonMode(opts)).toBe(false);
  });

  it("returns true and backfills output when --json is true and output is undefined", () => {
    const opts: { json?: boolean; output?: string } = { json: true };
    expect(resolveJsonMode(opts)).toBe(true);
    expect(opts.output).toBe("json");
  });

  it("returns true and backfills output when --json is true and output is 'text'", () => {
    const opts = { json: true, output: "text" };
    expect(resolveJsonMode(opts)).toBe(true);
    expect(opts.output).toBe("json");
  });

  it("returns false when no flags set", () => {
    expect(resolveJsonMode({})).toBe(false);
  });
});

// ── redactAccountIdIfDemoMode ────────────────────────────────────────────────

describe("redactAccountIdIfDemoMode", () => {
  const REAL_ACCOUNT = "054125018476";
  const ARN_WITH_ACCOUNT = `arn:aws:s3:::my-bucket`;
  const ARN_ACCOUNT_BEARING = `arn:aws:iam::${REAL_ACCOUNT}:role/my-role`;
  const REDACTED_ARN = `arn:aws:iam::************:role/my-role`;
  const MULTI_ARN = `arn:aws:iam::${REAL_ACCOUNT}:user/foo arn:aws:sts::${REAL_ACCOUNT}:assumed-role/bar`;
  const REDACTED_MULTI = `arn:aws:iam::************:user/foo arn:aws:sts::************:assumed-role/bar`;

  beforeEach(() => {
    delete process.env["ASSIGNEE_DEMO_REDACT_ACCOUNT"];
  });

  afterEach(() => {
    delete process.env["ASSIGNEE_DEMO_REDACT_ACCOUNT"];
  });

  it("returns text unchanged when env var is unset", () => {
    expect(redactAccountIdIfDemoMode(ARN_ACCOUNT_BEARING)).toBe(
      ARN_ACCOUNT_BEARING,
    );
  });

  it("returns text unchanged when env var is '0'", () => {
    process.env["ASSIGNEE_DEMO_REDACT_ACCOUNT"] = "0";
    expect(redactAccountIdIfDemoMode(ARN_ACCOUNT_BEARING)).toBe(
      ARN_ACCOUNT_BEARING,
    );
  });

  it("returns text unchanged when env var is empty string", () => {
    process.env["ASSIGNEE_DEMO_REDACT_ACCOUNT"] = "";
    expect(redactAccountIdIfDemoMode(ARN_ACCOUNT_BEARING)).toBe(
      ARN_ACCOUNT_BEARING,
    );
  });

  it("redacts 12-digit account ID in ARN when env var is '1'", () => {
    process.env["ASSIGNEE_DEMO_REDACT_ACCOUNT"] = "1";
    expect(redactAccountIdIfDemoMode(ARN_ACCOUNT_BEARING)).toBe(REDACTED_ARN);
  });

  it("redacts multiple account IDs in a single string", () => {
    process.env["ASSIGNEE_DEMO_REDACT_ACCOUNT"] = "1";
    expect(redactAccountIdIfDemoMode(MULTI_ARN)).toBe(REDACTED_MULTI);
  });

  it("does not redact S3 ARNs that have no account segment", () => {
    process.env["ASSIGNEE_DEMO_REDACT_ACCOUNT"] = "1";
    // S3 ARNs use arn:aws:s3:::bucket — no account ID before ":"
    expect(redactAccountIdIfDemoMode(ARN_WITH_ACCOUNT)).toBe(ARN_WITH_ACCOUNT);
  });

  it("does not redact standalone 12-digit numbers not followed by ':'", () => {
    process.env["ASSIGNEE_DEMO_REDACT_ACCOUNT"] = "1";
    // A 12-digit number in a cost string, not followed by ":"
    const costLine = "Estimated total: $123456789012.00/mo";
    expect(redactAccountIdIfDemoMode(costLine)).toBe(costLine);
  });

  it("redacts account ID inside a JSON envelope (realistic list output)", () => {
    process.env["ASSIGNEE_DEMO_REDACT_ACCOUNT"] = "1";
    const json = JSON.stringify(
      {
        ok: true,
        resources: [
          {
            arn: `arn:aws:lambda:us-east-1:${REAL_ACCOUNT}:function:my-fn`,
            type: "AWS::Lambda::Function",
          },
        ],
        count: 1,
        region: "us-east-1",
      },
      null,
      2,
    );
    const result = redactAccountIdIfDemoMode(json);
    expect(result).not.toContain(REAL_ACCOUNT);
    expect(result).toContain("************");
    // Non-account data is preserved
    expect(result).toContain("my-fn");
    expect(result).toContain("us-east-1");
  });

  it("redacts account ID inside an apply success envelope", () => {
    process.env["ASSIGNEE_DEMO_REDACT_ACCOUNT"] = "1";
    const json = JSON.stringify(
      {
        ok: true,
        operation: "apply",
        runId: "run-abc",
        arn: `arn:aws:s3:::my-bucket`,
      },
      null,
      2,
    );
    // S3 ARN has no account — nothing to redact
    const result = redactAccountIdIfDemoMode(json);
    expect(result).toBe(json);
  });

  it("redacts GovCloud and China partition ARNs (partition-aware)", () => {
    process.env["ASSIGNEE_DEMO_REDACT_ACCOUNT"] = "1";
    const govArn = `arn:aws-us-gov:iam::${REAL_ACCOUNT}:role/r`;
    const cnArn = `arn:aws-cn:iam::${REAL_ACCOUNT}:role/r`;
    expect(redactAccountIdIfDemoMode(govArn)).toBe(
      `arn:aws-us-gov:iam::************:role/r`,
    );
    expect(redactAccountIdIfDemoMode(cnArn)).toBe(
      `arn:aws-cn:iam::************:role/r`,
    );
  });
});

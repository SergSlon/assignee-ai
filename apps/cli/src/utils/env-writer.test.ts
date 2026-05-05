import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { mergeEnvFile } from "./env-writer.js";

// Realistic AWS-shape fixtures — well-known docs example AKID + IAM-shaped
// secret + a 240-char STS-style session token containing `=` padding and
// `+`/`/` Base64 alphabet characters. Mirrors what `assignee setup` and STS
// actually emit so regex / parser regressions surface against true shapes
// instead of synthetic "OLD"/"NEW" placeholders.
const AKID_OPERATOR_NEW = "AKIAIOSFODNN7EXAMPLE";
const AKID_OPERATOR_OLD = "AKIAI44QH8DHBEXAMPLE";
const AKID_READER_NEW = "AKIAJBCDEFGHIJKLMNOP";
const AKID_OPERATOR_TEMP = "ASIAIOSFODNN7EXAMPLE";
const AKID_READER_TEMP = "ASIAJBCDEFGHIJKLMNOP";
const SECRET_OPERATOR_NEW = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const SECRET_OPERATOR_OLD = "9hKjLmNoPqRsTuVwXyZ0/AbCdEfGhIjKlMnOp123";
const SECRET_READER_NEW = "QrStUvWxYz0123456789/AbCdEfGhIjKlMnOpQrSt";
const SECRET_OPERATOR_TEMP = "tEMP1234567890AbCdEfGh/IjKlMnOpQrStUvWxYz";
// 240-char STS-shaped token: realistic Base64 with =, /, + characters.
const SESSION_TOKEN_FRESH =
  "IQoJb3JpZ2luX2VjEJr//////////wEaCXVzLWVhc3QtMSJHMEUCIQD" +
  "+EXAMPLEFRESH/PAYLOAD/abc123ABC==xYz9876543210/wxyz" +
  "PLUS+SIGN+BASE64+CONTENT/withSlashes/AAA+BBB+CCC=" +
  "moreAndMorePaddingToReachRealSTSResponseLengthAA==" +
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuv==";
const SESSION_TOKEN_STALE =
  "IQoJb3JpZ2luX2VjEJr//////////wEaCXVzLWVhc3QtMSJHMEUCIQD" +
  "STALE+OLD+TOKEN/PAYLOAD/xyz789XYZ==aBc1234567890/abcd" +
  "PLUS+SIGN+BASE64+CONTENT/withSlashes/ZZZ+YYY+XXX=" +
  "expiredPaddingToReachRealSTSResponseLengthBB==BBBB" +
  "0987654321zyxwvutsrqponmlkjihgfedcbaZYXWVUTSRQPO==";
const SESSION_TOKEN_READER_STALE =
  "IQoJb3JpZ2luX2VjEJr//////////wEaCXVzLWVhc3QtMSJHMEUCIQD" +
  "READER+STALE+TOKEN+EXAMPLE/payload/123abc/ABC==xYz=" +
  "PLUS+SIGN+BASE64+CONTENT/withSlashes/RRR+EEE+AAA=" +
  "readerExpiredPaddingToHitRealSTSResponseLengthCC==" +
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuv==";
const SESSION_TOKEN_OPERATOR_KEEP =
  "IQoJb3JpZ2luX2VjEJr//////////wEaCXVzLWVhc3QtMSJHMEUCIQD" +
  "KEEP+ME+ALONE+EXAMPLE/payload/keep123KEEP==xYz9876/k" +
  "PLUS+SIGN+BASE64+CONTENT/withSlashes/KKK+EEE+PPP=" +
  "keepPaddingToReachRealSTSResponseLengthDDDDDDDD==DD" +
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuv==";
const SESSION_TOKEN_AWS_PRESERVE =
  "IQoJb3JpZ2luX2VjEJr//////////wEaCXVzLWVhc3QtMSJHMEUCIQD" +
  "AWS+EXPORT+TOKEN+EXAMPLE/payload/awsSso/ABC==xYz0/aws" +
  "PLUS+SIGN+BASE64+CONTENT/withSlashes/AAA+WWW+SSS=" +
  "awsExportPaddingToReachRealSTSResponseLengthEE==EE" +
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuv==";

describe("mergeEnvFile", () => {
  let tmpDir: string;
  let envPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "env-writer-test-"));
    envPath = path.join(tmpDir, ".env");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates a new .env file when none exists", () => {
    mergeEnvFile(envPath, {
      ASSIGNEE_OPERATOR_ACCESS_KEY_ID: AKID_OPERATOR_NEW,
      ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY: SECRET_OPERATOR_NEW,
    });

    const content = fs.readFileSync(envPath, "utf-8");
    expect(content).toContain(
      `ASSIGNEE_OPERATOR_ACCESS_KEY_ID=${AKID_OPERATOR_NEW}`,
    );
    expect(content).toContain(
      `ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY=${SECRET_OPERATOR_NEW}`,
    );
  });

  it("merges into an existing .env file preserving other vars", () => {
    fs.writeFileSync(
      envPath,
      "BEDROCK_MODEL_ID=us.amazon.nova-lite-v1:0\nAWS_REGION=us-east-1\n",
    );

    mergeEnvFile(envPath, {
      ASSIGNEE_OPERATOR_ACCESS_KEY_ID: AKID_OPERATOR_NEW,
    });

    const content = fs.readFileSync(envPath, "utf-8");
    expect(content).toContain("BEDROCK_MODEL_ID=us.amazon.nova-lite-v1:0");
    expect(content).toContain("AWS_REGION=us-east-1");
    expect(content).toContain(
      `ASSIGNEE_OPERATOR_ACCESS_KEY_ID=${AKID_OPERATOR_NEW}`,
    );
  });

  it("updates existing keys in place", () => {
    fs.writeFileSync(
      envPath,
      `ASSIGNEE_OPERATOR_ACCESS_KEY_ID=${AKID_OPERATOR_OLD}\n` +
        `ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY=${SECRET_OPERATOR_OLD}\n`,
    );

    mergeEnvFile(envPath, {
      ASSIGNEE_OPERATOR_ACCESS_KEY_ID: AKID_OPERATOR_NEW,
      ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY: SECRET_OPERATOR_NEW,
    });

    const content = fs.readFileSync(envPath, "utf-8");
    expect(content).toContain(
      `ASSIGNEE_OPERATOR_ACCESS_KEY_ID=${AKID_OPERATOR_NEW}`,
    );
    expect(content).toContain(
      `ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY=${SECRET_OPERATOR_NEW}`,
    );
    expect(content).not.toContain(AKID_OPERATOR_OLD);
    expect(content).not.toContain(SECRET_OPERATOR_OLD);
  });

  it("preserves comments and blank lines", () => {
    fs.writeFileSync(
      envPath,
      "# This is a comment\n\nBEDROCK_MODEL_ID=test\n# Another comment\n",
    );

    mergeEnvFile(envPath, {
      ASSIGNEE_OPERATOR_ACCESS_KEY_ID: AKID_OPERATOR_NEW,
    });

    const content = fs.readFileSync(envPath, "utf-8");
    expect(content).toContain("# This is a comment");
    expect(content).toContain("# Another comment");
    expect(content).toContain("BEDROCK_MODEL_ID=test");
  });

  it("removes deprecated MCP_AWS_* keys", () => {
    fs.writeFileSync(
      envPath,
      `MCP_AWS_ACCESS_KEY_ID=${AKID_OPERATOR_OLD}\n` +
        `MCP_AWS_SECRET_ACCESS_KEY=${SECRET_OPERATOR_OLD}\n` +
        "BEDROCK_MODEL_ID=test\n",
    );

    mergeEnvFile(envPath, {
      ASSIGNEE_OPERATOR_ACCESS_KEY_ID: AKID_OPERATOR_NEW,
    });

    const content = fs.readFileSync(envPath, "utf-8");
    expect(content).not.toContain("MCP_AWS_ACCESS_KEY_ID");
    expect(content).not.toContain("MCP_AWS_SECRET_ACCESS_KEY");
    expect(content).toContain("BEDROCK_MODEL_ID=test");
  });

  it("removes deprecated AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY keys", () => {
    fs.writeFileSync(
      envPath,
      `AWS_ACCESS_KEY_ID=${AKID_OPERATOR_OLD}\n` +
        `AWS_SECRET_ACCESS_KEY=${SECRET_OPERATOR_OLD}\n` +
        "BEDROCK_MODEL_ID=test\n",
    );

    mergeEnvFile(envPath, {
      ASSIGNEE_OPERATOR_ACCESS_KEY_ID: AKID_OPERATOR_NEW,
    });

    const content = fs.readFileSync(envPath, "utf-8");
    expect(content).not.toContain("AWS_ACCESS_KEY_ID");
    expect(content).not.toContain("AWS_SECRET_ACCESS_KEY");
    expect(content).toContain("BEDROCK_MODEL_ID=test");
  });

  it("ends the file with a newline", () => {
    mergeEnvFile(envPath, {
      ASSIGNEE_OPERATOR_ACCESS_KEY_ID: AKID_OPERATOR_NEW,
    });
    const content = fs.readFileSync(envPath, "utf-8");
    expect(content.endsWith("\n")).toBe(true);
  });

  // Regression: when `assignee setup` rotates a long-lived AKIA key for a
  // role, any pre-existing `*_SESSION_TOKEN` for that role is necessarily
  // stale. Leaving it on disk caused Bedrock to reject every LLM call
  // with "The security token included in the request is invalid",
  // surfacing as the misleading "No AWS credentials detected" error
  // because the catalog matcher converted the Bedrock failure to
  // MISSING_CREDENTIALS. The merge must evict stale session tokens
  // whenever the paired AKID is rotated without a matching new token.
  it("evicts stale *_SESSION_TOKEN when rotating its paired AKID", () => {
    fs.writeFileSync(
      envPath,
      `ASSIGNEE_OPERATOR_ACCESS_KEY_ID=${AKID_OPERATOR_TEMP}\n` +
        `ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY=${SECRET_OPERATOR_TEMP}\n` +
        `ASSIGNEE_OPERATOR_SESSION_TOKEN=${SESSION_TOKEN_STALE}\n` +
        `ASSIGNEE_READER_ACCESS_KEY_ID=${AKID_READER_TEMP}\n` +
        `ASSIGNEE_READER_SESSION_TOKEN=${SESSION_TOKEN_READER_STALE}\n` +
        "BEDROCK_MODEL_ID=test\n",
    );

    mergeEnvFile(envPath, {
      ASSIGNEE_OPERATOR_ACCESS_KEY_ID: AKID_OPERATOR_NEW,
      ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY: SECRET_OPERATOR_NEW,
      ASSIGNEE_READER_ACCESS_KEY_ID: AKID_READER_NEW,
      ASSIGNEE_READER_SECRET_ACCESS_KEY: SECRET_READER_NEW,
    });

    const content = fs.readFileSync(envPath, "utf-8");
    expect(content).toContain(
      `ASSIGNEE_OPERATOR_ACCESS_KEY_ID=${AKID_OPERATOR_NEW}`,
    );
    // SECRET landed too — eviction must NOT drop the rotated secret line.
    expect(content).toContain(
      `ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY=${SECRET_OPERATOR_NEW}`,
    );
    expect(content).toContain(
      `ASSIGNEE_READER_ACCESS_KEY_ID=${AKID_READER_NEW}`,
    );
    expect(content).toContain(
      `ASSIGNEE_READER_SECRET_ACCESS_KEY=${SECRET_READER_NEW}`,
    );
    expect(content).not.toContain("ASSIGNEE_OPERATOR_SESSION_TOKEN");
    expect(content).not.toContain("ASSIGNEE_READER_SESSION_TOKEN");
    expect(content).not.toContain(SESSION_TOKEN_STALE);
    expect(content).not.toContain(SESSION_TOKEN_READER_STALE);
    expect(content).toContain("BEDROCK_MODEL_ID=test");
  });

  it("preserves *_SESSION_TOKEN when it is part of the same update batch", () => {
    fs.writeFileSync(
      envPath,
      `ASSIGNEE_OPERATOR_ACCESS_KEY_ID=${AKID_OPERATOR_TEMP}\n` +
        `ASSIGNEE_OPERATOR_SESSION_TOKEN=${SESSION_TOKEN_STALE}\n`,
    );

    mergeEnvFile(envPath, {
      ASSIGNEE_OPERATOR_ACCESS_KEY_ID: AKID_OPERATOR_TEMP,
      ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY: SECRET_OPERATOR_TEMP,
      ASSIGNEE_OPERATOR_SESSION_TOKEN: SESSION_TOKEN_FRESH,
    });

    const content = fs.readFileSync(envPath, "utf-8");
    expect(content).toContain(
      `ASSIGNEE_OPERATOR_ACCESS_KEY_ID=${AKID_OPERATOR_TEMP}`,
    );
    expect(content).toContain(
      `ASSIGNEE_OPERATOR_SESSION_TOKEN=${SESSION_TOKEN_FRESH}`,
    );
    expect(content).not.toContain(SESSION_TOKEN_STALE);
  });

  it("leaves *_SESSION_TOKEN alone when paired AKID is not rotated", () => {
    fs.writeFileSync(
      envPath,
      `ASSIGNEE_OPERATOR_ACCESS_KEY_ID=${AKID_OPERATOR_NEW}\n` +
        `ASSIGNEE_OPERATOR_SESSION_TOKEN=${SESSION_TOKEN_OPERATOR_KEEP}\n` +
        "BEDROCK_MODEL_ID=before\n",
    );

    mergeEnvFile(envPath, { BEDROCK_MODEL_ID: "after" });

    const content = fs.readFileSync(envPath, "utf-8");
    expect(content).toContain(
      `ASSIGNEE_OPERATOR_ACCESS_KEY_ID=${AKID_OPERATOR_NEW}`,
    );
    expect(content).toContain(
      `ASSIGNEE_OPERATOR_SESSION_TOKEN=${SESSION_TOKEN_OPERATOR_KEEP}`,
    );
    expect(content).toContain("BEDROCK_MODEL_ID=after");
  });

  // Regression for the HIGH-severity reviewer finding: rotating
  // ASSIGNEE_OPERATOR_* MUST NOT touch unrelated AWS_* env vars. A
  // greedy `^(.+)_ACCESS_KEY_ID$` regex would derive a phantom
  // `_SESSION_TOKEN` key from `AWS_ACCESS_KEY_ID` (after that key is
  // also stripped via DEPRECATED_KEYS), but the more dangerous case is
  // the unscoped sibling `AWS_SESSION_TOKEN` that users legitimately
  // populate via `aws sso export-credentials`. The tightened regex
  // (allowlist of OPERATOR/READER/AUDITOR) must leave AWS_* lines
  // alone except for the explicit DEPRECATED_KEYS removal of
  // AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY.
  it("preserves AWS_SESSION_TOKEN when rotating ASSIGNEE_OPERATOR_*", () => {
    fs.writeFileSync(
      envPath,
      `AWS_SESSION_TOKEN=${SESSION_TOKEN_AWS_PRESERVE}\n` +
        "AWS_REGION=us-east-1\n" +
        `ASSIGNEE_OPERATOR_ACCESS_KEY_ID=${AKID_OPERATOR_OLD}\n` +
        `ASSIGNEE_OPERATOR_SESSION_TOKEN=${SESSION_TOKEN_STALE}\n`,
    );

    mergeEnvFile(envPath, {
      ASSIGNEE_OPERATOR_ACCESS_KEY_ID: AKID_OPERATOR_NEW,
      ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY: SECRET_OPERATOR_NEW,
    });

    const content = fs.readFileSync(envPath, "utf-8");
    // AWS_SESSION_TOKEN must survive — it is unrelated to the
    // ASSIGNEE_OPERATOR rotation. A greedy regex would have evicted it.
    expect(content).toContain(
      `AWS_SESSION_TOKEN=${SESSION_TOKEN_AWS_PRESERVE}`,
    );
    expect(content).toContain("AWS_REGION=us-east-1");
    // ASSIGNEE_OPERATOR_SESSION_TOKEN line is correctly removed.
    expect(content).not.toContain("ASSIGNEE_OPERATOR_SESSION_TOKEN");
    expect(content).not.toContain(SESSION_TOKEN_STALE);
    expect(content).toContain(
      `ASSIGNEE_OPERATOR_ACCESS_KEY_ID=${AKID_OPERATOR_NEW}`,
    );
    expect(content).toContain(
      `ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY=${SECRET_OPERATOR_NEW}`,
    );
  });

  it("preserves a commented-out *_SESSION_TOKEN line during rotation", () => {
    // A user had a leading `#` for documentation/example purposes; the
    // line is not an active assignment. Eviction must compare against the
    // un-commented key, so the comment line stays intact.
    fs.writeFileSync(
      envPath,
      "# ASSIGNEE_OPERATOR_SESSION_TOKEN=example-do-not-uncomment\n" +
        `ASSIGNEE_OPERATOR_ACCESS_KEY_ID=${AKID_OPERATOR_OLD}\n`,
    );

    mergeEnvFile(envPath, {
      ASSIGNEE_OPERATOR_ACCESS_KEY_ID: AKID_OPERATOR_NEW,
      ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY: SECRET_OPERATOR_NEW,
    });

    const content = fs.readFileSync(envPath, "utf-8");
    expect(content).toContain(
      "# ASSIGNEE_OPERATOR_SESSION_TOKEN=example-do-not-uncomment",
    );
    expect(content).toContain(
      `ASSIGNEE_OPERATOR_ACCESS_KEY_ID=${AKID_OPERATOR_NEW}`,
    );
  });

  it("preserves STS-shaped session token with `=` padding when in update batch", () => {
    // Boundary: parser must split key=value at the FIRST `=` only.
    // Realistic STS tokens always contain `=` padding characters in
    // their Base64 body and end with `==`. A naive split-on-`=` would
    // truncate the token; the helper writes back the raw value as-is.
    fs.writeFileSync(
      envPath,
      `ASSIGNEE_OPERATOR_ACCESS_KEY_ID=${AKID_OPERATOR_TEMP}\n` +
        `ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY=${SECRET_OPERATOR_TEMP}\n` +
        `ASSIGNEE_OPERATOR_SESSION_TOKEN=${SESSION_TOKEN_STALE}\n`,
    );

    mergeEnvFile(envPath, {
      ASSIGNEE_OPERATOR_ACCESS_KEY_ID: AKID_OPERATOR_TEMP,
      ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY: SECRET_OPERATOR_TEMP,
      ASSIGNEE_OPERATOR_SESSION_TOKEN: SESSION_TOKEN_FRESH,
    });

    const content = fs.readFileSync(envPath, "utf-8");
    // Full token landed verbatim, including trailing `==` padding and
    // `+`/`/` Base64 alphabet chars.
    expect(content).toContain(
      `ASSIGNEE_OPERATOR_SESSION_TOKEN=${SESSION_TOKEN_FRESH}`,
    );
    expect(SESSION_TOKEN_FRESH).toMatch(/==$/);
    expect(SESSION_TOKEN_FRESH).toContain("/");
    expect(SESSION_TOKEN_FRESH).toContain("+");
    expect(content).not.toContain(SESSION_TOKEN_STALE);
  });

  it("creates parent directory with 0700 mode when it does not exist", async () => {
    // Skip on Windows — POSIX mode bits do not apply.
    if (process.platform === "win32") return;

    // Use a fresh nested directory that does NOT yet exist so mkdirSync runs.
    const nestedDir = path.join(tmpDir, "nested-creds-dir");
    const nestedEnvPath = path.join(nestedDir, ".env");

    mergeEnvFile(nestedEnvPath, {
      ASSIGNEE_OPERATOR_ACCESS_KEY_ID: AKID_OPERATOR_NEW,
    });

    const stat = await fs.promises.stat(nestedDir);
    // Assert only the permission bits (0o777 mask filters out file-type bits).
    expect(stat.mode & 0o777).toBe(0o700);
  });

  it("hardens parent directory mode to 0700 even when dir pre-existed with looser mode", async () => {
    // Skip on Windows — POSIX mode bits do not apply.
    if (process.platform === "win32") return;

    // Pre-create the dir with world-readable 0755 to simulate umask-default mkdir.
    const looseDir = path.join(tmpDir, "loose-creds-dir");
    fs.mkdirSync(looseDir, { mode: 0o755 });
    fs.chmodSync(looseDir, 0o755); // Belt-and-braces: umask may have masked the mkdirSync mode.
    const looseEnvPath = path.join(looseDir, ".env");

    mergeEnvFile(looseEnvPath, {
      ASSIGNEE_OPERATOR_ACCESS_KEY_ID: AKID_OPERATOR_NEW,
    });

    const stat = await fs.promises.stat(looseDir);
    expect(stat.mode & 0o777).toBe(0o700);
  });
});

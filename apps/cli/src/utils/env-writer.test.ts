import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { mergeEnvFile } from "./env-writer.js";

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
      ASSIGNEE_OPERATOR_ACCESS_KEY_ID: "AKIA_OP",
      ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY: "secret_op",
    });

    const content = fs.readFileSync(envPath, "utf-8");
    expect(content).toContain("ASSIGNEE_OPERATOR_ACCESS_KEY_ID=AKIA_OP");
    expect(content).toContain("ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY=secret_op");
  });

  it("merges into an existing .env file preserving other vars", () => {
    fs.writeFileSync(
      envPath,
      "BEDROCK_MODEL_ID=us.amazon.nova-lite-v1:0\nAWS_REGION=us-east-1\n",
    );

    mergeEnvFile(envPath, {
      ASSIGNEE_OPERATOR_ACCESS_KEY_ID: "AKIA_NEW",
    });

    const content = fs.readFileSync(envPath, "utf-8");
    expect(content).toContain("BEDROCK_MODEL_ID=us.amazon.nova-lite-v1:0");
    expect(content).toContain("AWS_REGION=us-east-1");
    expect(content).toContain("ASSIGNEE_OPERATOR_ACCESS_KEY_ID=AKIA_NEW");
  });

  it("updates existing keys in place", () => {
    fs.writeFileSync(
      envPath,
      "ASSIGNEE_OPERATOR_ACCESS_KEY_ID=OLD_KEY\nASSIGNEE_OPERATOR_SECRET_ACCESS_KEY=OLD_SECRET\n",
    );

    mergeEnvFile(envPath, {
      ASSIGNEE_OPERATOR_ACCESS_KEY_ID: "NEW_KEY",
      ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY: "NEW_SECRET",
    });

    const content = fs.readFileSync(envPath, "utf-8");
    expect(content).toContain("ASSIGNEE_OPERATOR_ACCESS_KEY_ID=NEW_KEY");
    expect(content).toContain("ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY=NEW_SECRET");
    expect(content).not.toContain("OLD_KEY");
    expect(content).not.toContain("OLD_SECRET");
  });

  it("preserves comments and blank lines", () => {
    fs.writeFileSync(
      envPath,
      "# This is a comment\n\nBEDROCK_MODEL_ID=test\n# Another comment\n",
    );

    mergeEnvFile(envPath, { ASSIGNEE_OPERATOR_ACCESS_KEY_ID: "AKIA_NEW" });

    const content = fs.readFileSync(envPath, "utf-8");
    expect(content).toContain("# This is a comment");
    expect(content).toContain("# Another comment");
    expect(content).toContain("BEDROCK_MODEL_ID=test");
  });

  it("removes deprecated MCP_AWS_* keys", () => {
    fs.writeFileSync(
      envPath,
      "MCP_AWS_ACCESS_KEY_ID=OLD\nMCP_AWS_SECRET_ACCESS_KEY=OLD_SECRET\nBEDROCK_MODEL_ID=test\n",
    );

    mergeEnvFile(envPath, { ASSIGNEE_OPERATOR_ACCESS_KEY_ID: "AKIA_NEW" });

    const content = fs.readFileSync(envPath, "utf-8");
    expect(content).not.toContain("MCP_AWS_ACCESS_KEY_ID");
    expect(content).not.toContain("MCP_AWS_SECRET_ACCESS_KEY");
    expect(content).toContain("BEDROCK_MODEL_ID=test");
  });

  it("removes deprecated AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY keys", () => {
    fs.writeFileSync(
      envPath,
      "AWS_ACCESS_KEY_ID=OLD\nAWS_SECRET_ACCESS_KEY=OLD_SECRET\nBEDROCK_MODEL_ID=test\n",
    );

    mergeEnvFile(envPath, {
      ASSIGNEE_OPERATOR_ACCESS_KEY_ID: "AKIA_NEW",
    });

    const content = fs.readFileSync(envPath, "utf-8");
    expect(content).not.toContain("AWS_ACCESS_KEY_ID");
    expect(content).not.toContain("AWS_SECRET_ACCESS_KEY");
    expect(content).toContain("BEDROCK_MODEL_ID=test");
  });

  it("ends the file with a newline", () => {
    mergeEnvFile(envPath, { ASSIGNEE_OPERATOR_ACCESS_KEY_ID: "AKIA_TEST" });
    const content = fs.readFileSync(envPath, "utf-8");
    expect(content.endsWith("\n")).toBe(true);
  });

  it("creates parent directory with 0700 mode when it does not exist", async () => {
    // Skip on Windows — POSIX mode bits do not apply.
    if (process.platform === "win32") return;

    // Use a fresh nested directory that does NOT yet exist so mkdirSync runs.
    const nestedDir = path.join(tmpDir, "nested-creds-dir");
    const nestedEnvPath = path.join(nestedDir, ".env");

    mergeEnvFile(nestedEnvPath, {
      ASSIGNEE_OPERATOR_ACCESS_KEY_ID: "AKIA_PARENT_MODE",
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
      ASSIGNEE_OPERATOR_ACCESS_KEY_ID: "AKIA_PRE_EXISTING",
    });

    const stat = await fs.promises.stat(looseDir);
    expect(stat.mode & 0o777).toBe(0o700);
  });
});

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
      AWS_ACCESS_KEY_ID: "AKIA_OP",
      AWS_SECRET_ACCESS_KEY: "secret_op",
    });

    const content = fs.readFileSync(envPath, "utf-8");
    expect(content).toContain("AWS_ACCESS_KEY_ID=AKIA_OP");
    expect(content).toContain("AWS_SECRET_ACCESS_KEY=secret_op");
  });

  it("merges into an existing .env file preserving other vars", () => {
    fs.writeFileSync(
      envPath,
      "BEDROCK_MODEL_ID=us.amazon.nova-lite-v1:0\nAWS_REGION=us-east-1\n",
    );

    mergeEnvFile(envPath, {
      AWS_ACCESS_KEY_ID: "AKIA_NEW",
    });

    const content = fs.readFileSync(envPath, "utf-8");
    expect(content).toContain("BEDROCK_MODEL_ID=us.amazon.nova-lite-v1:0");
    expect(content).toContain("AWS_REGION=us-east-1");
    expect(content).toContain("AWS_ACCESS_KEY_ID=AKIA_NEW");
  });

  it("updates existing keys in place", () => {
    fs.writeFileSync(
      envPath,
      "AWS_ACCESS_KEY_ID=OLD_KEY\nAWS_SECRET_ACCESS_KEY=OLD_SECRET\n",
    );

    mergeEnvFile(envPath, {
      AWS_ACCESS_KEY_ID: "NEW_KEY",
      AWS_SECRET_ACCESS_KEY: "NEW_SECRET",
    });

    const content = fs.readFileSync(envPath, "utf-8");
    expect(content).toContain("AWS_ACCESS_KEY_ID=NEW_KEY");
    expect(content).toContain("AWS_SECRET_ACCESS_KEY=NEW_SECRET");
    expect(content).not.toContain("OLD_KEY");
    expect(content).not.toContain("OLD_SECRET");
  });

  it("preserves comments and blank lines", () => {
    fs.writeFileSync(
      envPath,
      "# This is a comment\n\nBEDROCK_MODEL_ID=test\n# Another comment\n",
    );

    mergeEnvFile(envPath, { AWS_ACCESS_KEY_ID: "AKIA_NEW" });

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

    mergeEnvFile(envPath, { AWS_ACCESS_KEY_ID: "AKIA_NEW" });

    const content = fs.readFileSync(envPath, "utf-8");
    expect(content).not.toContain("MCP_AWS_ACCESS_KEY_ID");
    expect(content).not.toContain("MCP_AWS_SECRET_ACCESS_KEY");
    expect(content).toContain("BEDROCK_MODEL_ID=test");
  });

  it("ends the file with a newline", () => {
    mergeEnvFile(envPath, { AWS_ACCESS_KEY_ID: "AKIA_TEST" });
    const content = fs.readFileSync(envPath, "utf-8");
    expect(content.endsWith("\n")).toBe(true);
  });
});

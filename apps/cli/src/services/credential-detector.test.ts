/**
 * Tests for AWS credential and region auto-detection.
 *
 * @see Story 18.1, AC #9
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  detectCredentials,
  detectRegion,
  parseIniFile,
} from "./credential-detector.js";

// ── Helpers ──────────────────────────────────────────────────────────────

/** Saved env vars to restore after each test. */
let savedEnv: Record<string, string | undefined>;

const ENV_KEYS = [
  "ASSIGNEE_OPERATOR_ACCESS_KEY_ID",
  "ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
] as const;

function saveAndClearEnv(): void {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
}

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] !== undefined) {
      process.env[key] = savedEnv[key];
    } else {
      delete process.env[key];
    }
  }
}

// ── parseIniFile ─────────────────────────────────────────────────────────

describe("parseIniFile", () => {
  it("parses a simple credentials file", () => {
    const content = `[default]
aws_access_key_id = AKIAIOSFODNN7EXAMPLE
aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY

[staging]
aws_access_key_id = AKIAI44QH8DHBEXAMPLE
aws_secret_access_key = je7MtGbClwBF/2Zp9Utk/h3yCo8nvbEXAMPLEKEY
`;
    const result = parseIniFile(content);

    // Tier C: dropped redundant toBeDefined() — toBe(literal) on
    // optional-chained access fails on undefined
    const defaultSection = result["default"]!;
    expect(defaultSection["aws_access_key_id"]).toBe("AKIAIOSFODNN7EXAMPLE");
    expect(defaultSection["aws_secret_access_key"]).toBe(
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    );

    // Tier C: same pattern
    const stagingSection = result["staging"]!;
    expect(stagingSection["aws_access_key_id"]).toBe("AKIAI44QH8DHBEXAMPLE");
  });

  it("handles [profile name] syntax from aws config", () => {
    const content = `[default]
region = us-east-1

[profile staging]
region = eu-west-1
`;
    const result = parseIniFile(content);

    expect(result["default"]?.["region"]).toBe("us-east-1");
    expect(result["staging"]?.["region"]).toBe("eu-west-1");
  });

  it("skips comments and empty lines", () => {
    const content = `# This is a comment
; This is also a comment

[default]
aws_access_key_id = AKIAIOSFODNN7EXAMPLE
`;
    const result = parseIniFile(content);
    expect(result["default"]?.["aws_access_key_id"]).toBe(
      "AKIAIOSFODNN7EXAMPLE",
    );
  });
});

// ── detectCredentials ────────────────────────────────────────────────────

describe("detectCredentials", () => {
  let tmpDir: string;

  beforeEach(async () => {
    saveAndClearEnv();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cred-test-"));
  });

  afterEach(async () => {
    restoreEnv();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("detects env var credentials and returns source 'env'", async () => {
    process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
    process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] =
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

    const result = await detectCredentials(tmpDir);

    expect(result.detected).toBe(true);
    expect(result.source).toBe("env");
    expect(result.profile).toBe("default");
  });

  it("detects env var credentials with custom AWS_PROFILE", async () => {
    process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
    process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] = "secret";
    process.env["AWS_PROFILE"] = "staging";

    const result = await detectCredentials(tmpDir);

    expect(result.detected).toBe(true);
    expect(result.source).toBe("env");
    expect(result.profile).toBe("staging");
  });

  it("detects ~/.aws/credentials file with default profile and returns source 'file'", async () => {
    const awsDir = path.join(tmpDir, ".aws");
    await fs.mkdir(awsDir, { recursive: true });
    await fs.writeFile(
      path.join(awsDir, "credentials"),
      `[default]
aws_access_key_id = AKIAIOSFODNN7EXAMPLE
aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
`,
    );

    const result = await detectCredentials(tmpDir);

    expect(result.detected).toBe(true);
    expect(result.source).toBe("file");
    expect(result.profile).toBe("default");
  });

  it("detects AWS SSO session and returns source 'sso'", async () => {
    const ssoCacheDir = path.join(tmpDir, ".aws", "sso", "cache");
    await fs.mkdir(ssoCacheDir, { recursive: true });

    const futureDate = new Date(Date.now() + 3600 * 1000).toISOString();
    await fs.writeFile(
      path.join(ssoCacheDir, "abc123.json"),
      JSON.stringify({
        accessToken: "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9",
        expiresAt: futureDate,
      }),
    );

    const result = await detectCredentials(tmpDir);

    expect(result.detected).toBe(true);
    expect(result.source).toBe("sso");
  });

  it("returns detected: false with actionable reason when no credentials found", async () => {
    const result = await detectCredentials(tmpDir);

    expect(result.detected).toBe(false);
    // Tier C: dropped redundant toBeDefined() — toContain fails on undefined
    expect(result.reason).toContain("No AWS credentials found");
    expect(result.reason).toContain("ASSIGNEE_OPERATOR_ACCESS_KEY_ID");
    expect(result.reason).toContain("~/.aws/credentials");
    expect(result.reason).toContain("AWS SSO");
  });

  it("skips expired SSO tokens", async () => {
    const ssoCacheDir = path.join(tmpDir, ".aws", "sso", "cache");
    await fs.mkdir(ssoCacheDir, { recursive: true });

    const pastDate = new Date(Date.now() - 3600 * 1000).toISOString();
    await fs.writeFile(
      path.join(ssoCacheDir, "expired.json"),
      JSON.stringify({
        accessToken: "expired-token",
        expiresAt: pastDate,
      }),
    );

    const result = await detectCredentials(tmpDir);

    expect(result.detected).toBe(false);
  });
});

// ── detectRegion ─────────────────────────────────────────────────────────

describe("detectRegion", () => {
  let tmpDir: string;

  beforeEach(async () => {
    saveAndClearEnv();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "region-test-"));
  });

  afterEach(async () => {
    restoreEnv();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("detects region from AWS_REGION env var", async () => {
    process.env["AWS_REGION"] = "eu-west-1";

    const result = await detectRegion(tmpDir);

    expect(result.region).toBe("eu-west-1");
  });

  it("detects region from AWS_DEFAULT_REGION env var", async () => {
    process.env["AWS_DEFAULT_REGION"] = "ap-southeast-1";

    const result = await detectRegion(tmpDir);

    expect(result.region).toBe("ap-southeast-1");
  });

  it("prefers AWS_REGION over AWS_DEFAULT_REGION", async () => {
    process.env["AWS_REGION"] = "us-west-2";
    process.env["AWS_DEFAULT_REGION"] = "eu-central-1";

    const result = await detectRegion(tmpDir);

    expect(result.region).toBe("us-west-2");
  });

  it("detects region from ~/.aws/config default profile", async () => {
    const awsDir = path.join(tmpDir, ".aws");
    await fs.mkdir(awsDir, { recursive: true });
    await fs.writeFile(
      path.join(awsDir, "config"),
      `[default]
region = us-west-2
output = json
`,
    );

    const result = await detectRegion(tmpDir);

    expect(result.region).toBe("us-west-2");
  });

  it("returns undefined region when not found anywhere", async () => {
    const result = await detectRegion(tmpDir);

    expect(result.region).toBeUndefined();
  });
});

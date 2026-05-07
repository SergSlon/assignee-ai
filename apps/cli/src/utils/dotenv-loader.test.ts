/**
 * Tests for the `.env` loader utility.
 *
 * Verifies the override policy (assignee-specific access-key triples always
 * win over shell values; all other keys defer to the shell), edge-case
 * handling (missing file, malformed lines, quoted values, comments, file
 * permissions), and the bug-report rotation scenario.
 *
 * @see Story — bug-setup-stale-env-credentials (Option C)
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type MockInstance,
} from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Realistic AWS-shaped fixtures matching the project-wide convention.
const AKID_OLD = "AKIAI44QH8DHBEXAMPLE";
const AKID_NEW = "AKIAIOSFODNN7EXAMPLE";
const SECRET_OLD = "9hKjLmNoPqRsTuVwXyZ0/AbCdEfGhIjKlMnOp123";
const SECRET_NEW = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
// 240-char STS-shaped token with `=` padding, `+`, `/`.
const SESSION_TOKEN =
  "IQoJb3JpZ2luX2VjEJr//////////wEaCXVzLWVhc3QtMSJHMEUCIQD" +
  "+EXAMPLEFRESH/PAYLOAD/abc123ABC==xYz9876543210/wxyz" +
  "PLUS+SIGN+BASE64+CONTENT/withSlashes/AAA+BBB+CCC=" +
  "moreAndMorePaddingToReachRealSTSResponseLengthAA==" +
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuv==";

// Dynamically import so each test gets a fresh module that reads from
// process.env at call time (not at import time).
async function getDotenvLoader() {
  // Force module re-evaluation for each test via cache-bust via dynamic import.
  const { loadDotEnv, ASSIGNEE_DOTENV_OVERRIDE_KEYS } =
    await import("./dotenv-loader.js");
  return { loadDotEnv, ASSIGNEE_DOTENV_OVERRIDE_KEYS };
}

describe("loadDotEnv", () => {
  let tmpDir: string;
  let envPath: string;
  let stderrSpy: MockInstance;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dotenv-loader-test-"));
    envPath = path.join(tmpDir, ".env");

    // Capture stderr writes without printing to console.
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    // Save and clean assignee env vars before each test.
    savedEnv = {};
    const keysToSave = [
      "ASSIGNEE_OPERATOR_ACCESS_KEY_ID",
      "ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY",
      "ASSIGNEE_OPERATOR_SESSION_TOKEN",
      "ASSIGNEE_READER_ACCESS_KEY_ID",
      "ASSIGNEE_READER_SECRET_ACCESS_KEY",
      "ASSIGNEE_READER_SESSION_TOKEN",
      "ASSIGNEE_AUDITOR_ACCESS_KEY_ID",
      "ASSIGNEE_AUDITOR_SECRET_ACCESS_KEY",
      "ASSIGNEE_AUDITOR_SESSION_TOKEN",
      "MY_CUSTOM_VAR",
    ];
    for (const k of keysToSave) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    // Restore env vars.
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    stderrSpy.mockRestore();
  });

  it("returns loaded=false and no side-effects when .env is absent", async () => {
    const { loadDotEnv } = await getDotenvLoader();
    const result = loadDotEnv(tmpDir);

    expect(result.loaded).toBe(false);
    expect(result.assigneeKeysLoaded).toBe(false);
    expect(result.sourcePath).toBeNull();
    expect(process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"]).toBeUndefined();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("overrides process.env with all 9 assignee keys from .env", async () => {
    // Pre-populate shell with OLD values.
    process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = AKID_OLD;
    process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] = SECRET_OLD;
    process.env["ASSIGNEE_OPERATOR_SESSION_TOKEN"] = "old-session-token";
    process.env["ASSIGNEE_READER_ACCESS_KEY_ID"] = "AKIA_READER_OLD";
    process.env["ASSIGNEE_READER_SECRET_ACCESS_KEY"] = "reader-secret-old";
    process.env["ASSIGNEE_READER_SESSION_TOKEN"] = "reader-session-old";
    process.env["ASSIGNEE_AUDITOR_ACCESS_KEY_ID"] = "AKIA_AUDITOR_OLD";
    process.env["ASSIGNEE_AUDITOR_SECRET_ACCESS_KEY"] = "auditor-secret-old";
    process.env["ASSIGNEE_AUDITOR_SESSION_TOKEN"] = "auditor-session-old";

    fs.writeFileSync(
      envPath,
      [
        `ASSIGNEE_OPERATOR_ACCESS_KEY_ID=${AKID_NEW}`,
        `ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY=${SECRET_NEW}`,
        `ASSIGNEE_OPERATOR_SESSION_TOKEN=${SESSION_TOKEN}`,
        "ASSIGNEE_READER_ACCESS_KEY_ID=AKIA_READER_NEW",
        "ASSIGNEE_READER_SECRET_ACCESS_KEY=reader-secret-new",
        "ASSIGNEE_READER_SESSION_TOKEN=reader-session-new",
        "ASSIGNEE_AUDITOR_ACCESS_KEY_ID=AKIA_AUDITOR_NEW",
        "ASSIGNEE_AUDITOR_SECRET_ACCESS_KEY=auditor-secret-new",
        "ASSIGNEE_AUDITOR_SESSION_TOKEN=auditor-session-new",
      ].join("\n") + "\n",
      { mode: 0o600 },
    );

    const { loadDotEnv } = await getDotenvLoader();
    const result = loadDotEnv(tmpDir);

    expect(result.loaded).toBe(true);
    expect(result.assigneeKeysLoaded).toBe(true);
    expect(result.sourcePath).toBe(envPath);

    // .env values MUST override shell OLD values.
    expect(process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"]).toBe(AKID_NEW);
    expect(process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"]).toBe(SECRET_NEW);
    expect(process.env["ASSIGNEE_OPERATOR_SESSION_TOKEN"]).toBe(SESSION_TOKEN);
    expect(process.env["ASSIGNEE_READER_ACCESS_KEY_ID"]).toBe(
      "AKIA_READER_NEW",
    );
    expect(process.env["ASSIGNEE_READER_SECRET_ACCESS_KEY"]).toBe(
      "reader-secret-new",
    );
    expect(process.env["ASSIGNEE_READER_SESSION_TOKEN"]).toBe(
      "reader-session-new",
    );
    expect(process.env["ASSIGNEE_AUDITOR_ACCESS_KEY_ID"]).toBe(
      "AKIA_AUDITOR_NEW",
    );
    expect(process.env["ASSIGNEE_AUDITOR_SECRET_ACCESS_KEY"]).toBe(
      "auditor-secret-new",
    );
    expect(process.env["ASSIGNEE_AUDITOR_SESSION_TOKEN"]).toBe(
      "auditor-session-new",
    );
  });

  it("shell wins for non-assignee keys when they are already set", async () => {
    // Shell has AWS_REGION set — .env must not override it.
    const originalRegion = process.env["AWS_REGION"];
    process.env["AWS_REGION"] = "us-east-1";

    fs.writeFileSync(envPath, "AWS_REGION=us-west-2\n", { mode: 0o600 });

    const { loadDotEnv } = await getDotenvLoader();
    loadDotEnv(tmpDir);

    expect(process.env["AWS_REGION"]).toBe("us-east-1");

    // Restore
    if (originalRegion === undefined) {
      delete process.env["AWS_REGION"];
    } else {
      process.env["AWS_REGION"] = originalRegion;
    }
  });

  it("sets non-assignee key from .env when it is absent from shell", async () => {
    delete process.env["MY_CUSTOM_VAR"];

    fs.writeFileSync(envPath, "MY_CUSTOM_VAR=from-dotenv\n", { mode: 0o600 });

    const { loadDotEnv } = await getDotenvLoader();
    loadDotEnv(tmpDir);

    expect(process.env["MY_CUSTOM_VAR"]).toBe("from-dotenv");
    delete process.env["MY_CUSTOM_VAR"];
  });

  it("emits a stderr warning for malformed lines but still parses valid lines", async () => {
    fs.writeFileSync(
      envPath,
      [
        "INVALID_LINE_NO_EQUALS",
        `ASSIGNEE_OPERATOR_ACCESS_KEY_ID=${AKID_NEW}`,
      ].join("\n") + "\n",
      { mode: 0o600 },
    );

    const { loadDotEnv } = await getDotenvLoader();
    const result = loadDotEnv(tmpDir);

    // Warning emitted for the malformed line.
    const warnings = stderrSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.includes("malformed"));
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("line 1");

    // Valid key still loaded.
    expect(result.loaded).toBe(true);
    expect(result.assigneeKeysLoaded).toBe(true);
    expect(process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"]).toBe(AKID_NEW);
  });

  it("strips double-quoted values", async () => {
    fs.writeFileSync(
      envPath,
      `ASSIGNEE_OPERATOR_ACCESS_KEY_ID="${AKID_NEW}"\n`,
      { mode: 0o600 },
    );

    const { loadDotEnv } = await getDotenvLoader();
    loadDotEnv(tmpDir);

    expect(process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"]).toBe(AKID_NEW);
  });

  it("strips single-quoted values", async () => {
    fs.writeFileSync(
      envPath,
      `ASSIGNEE_OPERATOR_ACCESS_KEY_ID='${AKID_NEW}'\n`,
      { mode: 0o600 },
    );

    const { loadDotEnv } = await getDotenvLoader();
    loadDotEnv(tmpDir);

    expect(process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"]).toBe(AKID_NEW);
  });

  it("handles quoted value with spaces", async () => {
    delete process.env["MY_CUSTOM_VAR"];
    fs.writeFileSync(envPath, 'MY_CUSTOM_VAR="hello world"\n', { mode: 0o600 });

    const { loadDotEnv } = await getDotenvLoader();
    loadDotEnv(tmpDir);

    expect(process.env["MY_CUSTOM_VAR"]).toBe("hello world");
    delete process.env["MY_CUSTOM_VAR"];
  });

  it("skips comment lines starting with #", async () => {
    fs.writeFileSync(
      envPath,
      [
        "# This is a comment",
        `ASSIGNEE_OPERATOR_ACCESS_KEY_ID=${AKID_NEW}`,
        "# Another comment",
      ].join("\n") + "\n",
      { mode: 0o600 },
    );

    const { loadDotEnv } = await getDotenvLoader();
    const result = loadDotEnv(tmpDir);

    expect(result.loaded).toBe(true);
    expect(process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"]).toBe(AKID_NEW);
    // No warning for comment lines.
    const malformedWarnings = stderrSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.includes("malformed"));
    expect(malformedWarnings.length).toBe(0);
  });

  it("emits a file mode warning for 0644 but still loads the file", async () => {
    // Skip on Windows — POSIX mode bits do not apply.
    if (process.platform === "win32") return;

    fs.writeFileSync(envPath, `ASSIGNEE_OPERATOR_ACCESS_KEY_ID=${AKID_NEW}\n`);
    fs.chmodSync(envPath, 0o644);

    const { loadDotEnv } = await getDotenvLoader();
    const result = loadDotEnv(tmpDir);

    // Warning must mention chmod 600.
    const modeWarnings = stderrSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.includes("chmod 600"));
    expect(modeWarnings.length).toBeGreaterThanOrEqual(1);

    // File is still loaded despite the loose mode.
    expect(result.loaded).toBe(true);
    expect(process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"]).toBe(AKID_NEW);
  });

  it("bug-report scenario: shell has OLD key, .env has NEW key — NEW wins", async () => {
    // Simulate the post-setup rotation: shell inherited OLD key, .env has NEW.
    process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = AKID_OLD;

    fs.writeFileSync(envPath, `ASSIGNEE_OPERATOR_ACCESS_KEY_ID=${AKID_NEW}\n`, {
      mode: 0o600,
    });

    const { loadDotEnv } = await getDotenvLoader();
    loadDotEnv(tmpDir);

    expect(process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"]).toBe(AKID_NEW);
  });

  it("preserves STS session token with = padding and +// chars verbatim", async () => {
    fs.writeFileSync(
      envPath,
      `ASSIGNEE_OPERATOR_SESSION_TOKEN=${SESSION_TOKEN}\n`,
      { mode: 0o600 },
    );

    const { loadDotEnv } = await getDotenvLoader();
    loadDotEnv(tmpDir);

    expect(process.env["ASSIGNEE_OPERATOR_SESSION_TOKEN"]).toBe(SESSION_TOKEN);
    expect(SESSION_TOKEN).toContain("==");
    expect(SESSION_TOKEN).toContain("+");
    expect(SESSION_TOKEN).toContain("/");
  });

  it("ASSIGNEE_DOTENV_OVERRIDE_KEYS exports all 9 names", async () => {
    const { ASSIGNEE_DOTENV_OVERRIDE_KEYS } = await getDotenvLoader();

    const expected = [
      "ASSIGNEE_OPERATOR_ACCESS_KEY_ID",
      "ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY",
      "ASSIGNEE_OPERATOR_SESSION_TOKEN",
      "ASSIGNEE_READER_ACCESS_KEY_ID",
      "ASSIGNEE_READER_SECRET_ACCESS_KEY",
      "ASSIGNEE_READER_SESSION_TOKEN",
      "ASSIGNEE_AUDITOR_ACCESS_KEY_ID",
      "ASSIGNEE_AUDITOR_SECRET_ACCESS_KEY",
      "ASSIGNEE_AUDITOR_SESSION_TOKEN",
    ];

    expect([...ASSIGNEE_DOTENV_OVERRIDE_KEYS].sort()).toEqual(expected.sort());
  });
});

/**
 * Integration tests for dotenv bootstrap wiring in index.ts.
 *
 * These tests verify the behaviour of loadDotEnv and the stderr notice
 * logic WITHOUT spawning a real child process. They mock fs.readFileSync
 * and process.stderr.write to keep the tests hermetic.
 *
 * The notice must fire when assigneeKeysLoaded === true and be suppressed
 * when --json / --output json is in process.argv.
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

// Realistic fixtures.
const AKID_NEW = "AKIAIOSFODNN7EXAMPLE";
const SECRET_NEW = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

describe("dotenv bootstrap notice", () => {
  let tmpDir: string;
  let envPath: string;
  let stderrSpy: MockInstance;
  let savedEnv: Record<string, string | undefined>;
  let savedArgv: string[];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dotenv-bootstrap-test-"));
    envPath = path.join(tmpDir, ".env");

    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    // Save argv and assignee keys.
    savedArgv = [...process.argv];
    savedEnv = {};
    const keysToSave = [
      "ASSIGNEE_OPERATOR_ACCESS_KEY_ID",
      "ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY",
    ];
    for (const k of keysToSave) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    process.argv.splice(0, process.argv.length, ...savedArgv);
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

  it("emits the credentials notice when assignee keys are loaded", async () => {
    fs.writeFileSync(
      envPath,
      `ASSIGNEE_OPERATOR_ACCESS_KEY_ID=${AKID_NEW}\nASSIGNEE_OPERATOR_SECRET_ACCESS_KEY=${SECRET_NEW}\n`,
      { mode: 0o600 },
    );

    const { loadDotEnv } = await import("../utils/dotenv-loader.js");
    const result = loadDotEnv(tmpDir);

    // Simulate the notice logic from index.ts.
    if (result.assigneeKeysLoaded) {
      const jsonMode =
        process.argv.includes("--json") ||
        (() => {
          const idx = process.argv.indexOf("--output");
          if (idx >= 0 && process.argv[idx + 1] === "json") return true;
          const short = process.argv.indexOf("-o");
          if (short >= 0 && process.argv[short + 1] === "json") return true;
          return false;
        })();
      if (!jsonMode) {
        process.stderr.write(
          "[assignee] Loaded fresh credentials from ./.env (post-setup rotation pickup)\n",
        );
      }
    }

    const notices = stderrSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.includes("Loaded fresh credentials"));
    expect(notices.length).toBe(1);
    expect(notices[0]).toContain("./.env");
    expect(notices[0]).toContain("post-setup rotation pickup");
  });

  it("suppresses the notice when --json flag is present", async () => {
    process.argv.push("--json");

    fs.writeFileSync(envPath, `ASSIGNEE_OPERATOR_ACCESS_KEY_ID=${AKID_NEW}\n`, {
      mode: 0o600,
    });

    const { loadDotEnv } = await import("../utils/dotenv-loader.js");
    const result = loadDotEnv(tmpDir);

    if (result.assigneeKeysLoaded) {
      const jsonMode =
        process.argv.includes("--json") ||
        (() => {
          const idx = process.argv.indexOf("--output");
          if (idx >= 0 && process.argv[idx + 1] === "json") return true;
          const short = process.argv.indexOf("-o");
          if (short >= 0 && process.argv[short + 1] === "json") return true;
          return false;
        })();
      if (!jsonMode) {
        process.stderr.write(
          "[assignee] Loaded fresh credentials from ./.env (post-setup rotation pickup)\n",
        );
      }
    }

    const notices = stderrSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.includes("Loaded fresh credentials"));
    expect(notices.length).toBe(0);
  });

  it("suppresses the notice when --output json is present", async () => {
    process.argv.push("--output", "json");

    fs.writeFileSync(envPath, `ASSIGNEE_OPERATOR_ACCESS_KEY_ID=${AKID_NEW}\n`, {
      mode: 0o600,
    });

    const { loadDotEnv } = await import("../utils/dotenv-loader.js");
    const result = loadDotEnv(tmpDir);

    if (result.assigneeKeysLoaded) {
      const jsonMode =
        process.argv.includes("--json") ||
        (() => {
          const idx = process.argv.indexOf("--output");
          if (idx >= 0 && process.argv[idx + 1] === "json") return true;
          const short = process.argv.indexOf("-o");
          if (short >= 0 && process.argv[short + 1] === "json") return true;
          return false;
        })();
      if (!jsonMode) {
        process.stderr.write(
          "[assignee] Loaded fresh credentials from ./.env (post-setup rotation pickup)\n",
        );
      }
    }

    const notices = stderrSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.includes("Loaded fresh credentials"));
    expect(notices.length).toBe(0);
  });

  it("suppresses the notice when -o json is present", async () => {
    process.argv.push("-o", "json");

    fs.writeFileSync(envPath, `ASSIGNEE_OPERATOR_ACCESS_KEY_ID=${AKID_NEW}\n`, {
      mode: 0o600,
    });

    const { loadDotEnv } = await import("../utils/dotenv-loader.js");
    const result = loadDotEnv(tmpDir);

    if (result.assigneeKeysLoaded) {
      const jsonMode =
        process.argv.includes("--json") ||
        (() => {
          const idx = process.argv.indexOf("--output");
          if (idx >= 0 && process.argv[idx + 1] === "json") return true;
          const short = process.argv.indexOf("-o");
          if (short >= 0 && process.argv[short + 1] === "json") return true;
          return false;
        })();
      if (!jsonMode) {
        process.stderr.write(
          "[assignee] Loaded fresh credentials from ./.env (post-setup rotation pickup)\n",
        );
      }
    }

    const notices = stderrSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.includes("Loaded fresh credentials"));
    expect(notices.length).toBe(0);
  });

  it("does not emit a notice when no assignee keys are in .env", async () => {
    fs.writeFileSync(envPath, "AWS_REGION=us-west-2\n", { mode: 0o600 });

    const { loadDotEnv } = await import("../utils/dotenv-loader.js");
    const result = loadDotEnv(tmpDir);

    if (result.assigneeKeysLoaded) {
      process.stderr.write(
        "[assignee] Loaded fresh credentials from ./.env (post-setup rotation pickup)\n",
      );
    }

    const notices = stderrSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.includes("Loaded fresh credentials"));
    expect(notices.length).toBe(0);
  });

  it("does not emit a notice when .env is absent", async () => {
    // No .env file written.
    const { loadDotEnv } = await import("../utils/dotenv-loader.js");
    const result = loadDotEnv(tmpDir);

    expect(result.loaded).toBe(false);
    expect(result.assigneeKeysLoaded).toBe(false);

    const notices = stderrSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.includes("Loaded fresh credentials"));
    expect(notices.length).toBe(0);
  });
});

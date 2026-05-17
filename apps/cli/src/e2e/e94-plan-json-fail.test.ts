/**
 * Epic 94 R5 (C-03) — E2E CLI probe: `plan --output json` error envelope.
 *
 * Regression: Wave 2.c shipped the success-path envelope
 * `{ok:true, plans:[...]}`, but the FAILURE path still emitted:
 *   - structured JSONL log lines to stdout
 *   - plaintext `[ERROR]/[CONTEXT]/[FIX]` blocks to stdout
 *   - A generic fallback envelope that hid the real error code.
 *
 * After R5: stdout is a SINGLE parseable JSON value; the envelope's
 * `error.code` matches the graph's stable machine-readable code
 * (`UNSUPPORTED_RESOURCE` in this probe); stderr remains rich with
 * human-readable diagnostics (logs + [ERROR] triple) so operators
 * still see the failure.
 *
 * This test drives the REAL built CLI. It is the only layer that
 * catches an end-to-end byte-order leak (e.g. if a future formatter
 * forgot to honour the interceptor).
 *
 * Gated by `RUN_E2E=1`. Run via:
 *   RUN_E2E=1 pnpm --filter assignee vitest run \
 *     src/e2e/e94-plan-json-fail.test.ts
 *
 * Requires:
 *   - `pnpm build` produced `apps/cli/dist/index.js`.
 *   - Real AWS credentials; the graph bootstraps (LLM + MCP) before
 *     intent parsing surfaces UNSUPPORTED_RESOURCE.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const RUN_E2E = process.env["RUN_E2E"] === "1";
const describeE2E = RUN_E2E ? describe : describe.skip;

// src/e2e/ → cli/ → apps/ → assignee.ai/
const CLI_DIST = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "dist",
  "index.js",
);
const ENV_PATH = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  ".env",
);

/**
 * Load assignee.ai/.env into process.env so the spawned CLI inherits
 * operator credentials.
 */
function loadEnv(): void {
  if (!fs.existsSync(ENV_PATH)) return;
  const content = fs.readFileSync(ENV_PATH, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx);
    const value = trimmed.slice(eqIdx + 1);
    process.env[key] = value;
  }
  delete process.env["AWS_ACCESS_KEY_ID"];
  delete process.env["AWS_SECRET_ACCESS_KEY"];
  delete process.env["AWS_SESSION_TOKEN"];
  delete process.env["AWS_PROFILE"];
}

function runCli(args: string[]): {
  code: number | null;
  stdout: string;
  stderr: string;
} {
  const res = spawnSync("node", [CLI_DIST, ...args], {
    encoding: "utf-8",
    timeout: 180_000,
    env: {
      ...process.env,
      ASSIGNEE_NO_UPDATE_CHECK: "1",
      NO_COLOR: "1",
    },
  });
  return {
    code: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

describeE2E(
  "Epic 94 R5 — plan --output json error envelope discipline (C-03)",
  () => {
    beforeAll(() => {
      loadEnv();
    });

    it("CLI dist exists (prerequisite — run `pnpm build` first)", () => {
      expect(fs.existsSync(CLI_DIST)).toBe(true);
    });

    it("unsupported intent → stdout is a SINGLE parseable JSON envelope", () => {
      const { stdout, stderr, code } = runCli([
        "infra",
        "plan",
        "--output",
        "json",
        "--no-apply",
        "Create an RDS db.t3.tiny.nope.not-a-class",
      ]);

      // Non-zero exit on failure.
      expect(code, `expected non-zero exit; got code=${code}`).not.toBe(0);

      // Single parse must succeed — that already rules out NDJSON +
      // plaintext leaks, because either would throw on JSON.parse.
      const trimmed = stdout.trim();
      expect(trimmed.length, "stdout must not be empty").toBeGreaterThan(0);

      let parsed: unknown;
      expect(
        () => {
          parsed = JSON.parse(trimmed);
        },
        `stdout must be a single parseable JSON value; got:\n${trimmed.slice(0, 400)}`,
      ).not.toThrow();

      // Shape: { ok:false, error:{ code, message, hint } }.
      const env = parsed as {
        ok: boolean;
        error: { code: string; message: string; hint?: string };
      };
      expect(env.ok).toBe(false);
      expect(typeof env.error.code).toBe("string");
      expect(env.error.code.length).toBeGreaterThan(0);
      // The specific code for this probe — intent-parser surfaces
      // UNSUPPORTED_RESOURCE through the graph; R5's orchestrator
      // change routes that status to code "UNSUPPORTED_RESOURCE"
      // rather than the generic "PLAN_FAILED" fallback.
      expect(env.error.code).toBe("UNSUPPORTED_RESOURCE");
      expect(env.error.message.length).toBeGreaterThan(0);
      expect(env.error.hint).toBeDefined();

      // Stderr still carries the human-readable diagnostics.
      expect(
        stderr.length,
        "stderr must retain logs + error block",
      ).toBeGreaterThan(0);
      // The renderError `[ERROR]` triple must land on stderr, not
      // stdout, because NO_COLOR=1 is set and the non-TTY branch emits
      // the bracketed markers.
      expect(stderr).toContain("[ERROR]");
      expect(stdout).not.toContain("[ERROR]");
      expect(stdout).not.toContain("[CONTEXT]");
      expect(stdout).not.toContain("[FIX]");

      // No NDJSON boundary on stdout — two concatenated root objects
      // would be `}\n{` somewhere between them.
      expect(trimmed.includes("}\n{")).toBe(false);
    });

    it("stderr byte length is non-trivial on the unsupported-resource probe", () => {
      const { stderr, code } = runCli([
        "infra",
        "plan",
        "--output",
        "json",
        "--no-apply",
        "Create an RDS db.t3.tiny.nope.not-a-class",
      ]);
      expect(code, `expected non-zero exit; got code=${code}`).not.toBe(0);
      // Empirical floor: the envelope on stderr's companion carries
      // at minimum the [ERROR] block (~60 bytes) + one log event
      // (~200 bytes) + the MCP connection messages. 200 is a generous
      // floor against a pathological truncation.
      expect(stderr.length).toBeGreaterThan(200);
    });
  },
);

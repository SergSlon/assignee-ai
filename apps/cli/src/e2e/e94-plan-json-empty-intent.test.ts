/**
 * Epic 94 N3 (A-03 / A-09) — E2E CLI probe: `plan --json` arg-parse
 * error envelope.
 *
 * Regression: Wave 94.R5 shipped the runtime-failure envelope
 * (`{ok:false, error:{code,message,hint}}` for
 * UNSUPPORTED_RESOURCE / PLAN_FAILED), but errors thrown from the
 * argument parser BEFORE the outer catch still bypassed the envelope:
 *
 *   - `plan "" --json` (empty intent) → stdout empty, stderr
 *     `Error: Missing intent. ...`. `jq` fails with no input.
 *   - `plan --json --set BAD-SYNTAX "valid intent"` → same bypass.
 *
 * After N3: arg-parse throws AssigneeError with stable codes
 * `MISSING_INTENT` / `BAD_SET_SYNTAX` and attached hints; plan.ts
 * routes them through the R5 envelope pipeline so stdout is a single
 * parseable `{ok:false, error:{...}}` value.
 *
 * This probe drives the REAL built CLI — unit tests can miss byte-
 * order leaks (e.g. the interceptor not being installed before
 * arg-parse).
 *
 * Gated by `RUN_E2E=1`. Run via:
 *   RUN_E2E=1 pnpm --filter assignee vitest run \
 *     src/e2e/e94-plan-json-empty-intent.test.ts
 *
 * Requires:
 *   - `pnpm build` produced `apps/cli/dist/index.js`.
 *   - No AWS credentials required — arg-parse fires before bootstrap.
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
 * operator credentials. Arg-parse errors fire before any AWS call, so
 * credentials aren't strictly required for this probe — but loading
 * the env keeps behaviour consistent with the sibling R5 probe.
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
    timeout: 30_000,
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
  "Epic 94 N3 — plan --json arg-parse error envelope (A-03 / A-09)",
  () => {
    beforeAll(() => {
      loadEnv();
    });

    it("CLI dist exists (prerequisite — run `pnpm build` first)", () => {
      expect(fs.existsSync(CLI_DIST)).toBe(true);
    });

    it("A-03: empty intent in --json mode → MISSING_INTENT envelope", () => {
      const { stdout, stderr, code } = runCli(["plan", "", "--json"]);

      expect(code, `expected non-zero exit; got code=${code}`).not.toBe(0);

      const trimmed = stdout.trim();
      expect(
        trimmed.length,
        "stdout must carry the envelope, not be empty",
      ).toBeGreaterThan(0);

      let parsed: unknown;
      expect(
        () => {
          parsed = JSON.parse(trimmed);
        },
        `stdout must parse as a single JSON value; got:\n${trimmed.slice(0, 400)}`,
      ).not.toThrow();

      const env = parsed as {
        ok: boolean;
        error: { code: string; message: string; hint?: string };
      };
      expect(env.ok).toBe(false);
      expect(env.error.code).toBe("MISSING_INTENT");
      expect(env.error.message).toContain("Missing intent");
      expect(env.error.hint).toBeDefined();
      expect(env.error.hint!.length).toBeGreaterThan(0);

      // stderr still carries the human-readable Error line for
      // non-JSON tooling that greps it.
      expect(stderr.length).toBeGreaterThan(0);

      // No NDJSON boundary on stdout.
      expect(trimmed.includes("}\n{")).toBe(false);
    });

    it("A-09: malformed --set token in --json mode → BAD_SET_SYNTAX envelope", () => {
      const { stdout, code } = runCli([
        "plan",
        "--json",
        "--set",
        "BAD-SYNTAX",
        "Create an S3 bucket named my-bucket",
      ]);

      expect(code, `expected non-zero exit; got code=${code}`).not.toBe(0);

      const trimmed = stdout.trim();
      expect(trimmed.length).toBeGreaterThan(0);

      let parsed: unknown;
      expect(
        () => {
          parsed = JSON.parse(trimmed);
        },
        `stdout must parse as a single JSON value; got:\n${trimmed.slice(0, 400)}`,
      ).not.toThrow();

      const env = parsed as {
        ok: boolean;
        error: { code: string; message: string; hint?: string };
      };
      expect(env.ok).toBe(false);
      expect(env.error.code).toBe("BAD_SET_SYNTAX");
      expect(env.error.message).toContain("Invalid --set token");
      expect(env.error.message).toContain("BAD-SYNTAX");
      expect(env.error.hint).toBeDefined();
      expect(env.error.hint!.length).toBeGreaterThan(0);
    });

    it("A-03 via --output json (long form): same MISSING_INTENT envelope", () => {
      // Ensure the long-form flag lands in the same branch as the
      // `--json` shorthand; regression-guards the aliasOpts normalization
      // in plan.ts where `opts.output ?? "text"` is read pre-arg-parse.
      const { stdout, code } = runCli(["plan", "--output", "json"]);
      expect(code).not.toBe(0);

      const parsed = JSON.parse(stdout.trim()) as {
        ok: boolean;
        error: { code: string };
      };
      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBe("MISSING_INTENT");
    });
  },
);

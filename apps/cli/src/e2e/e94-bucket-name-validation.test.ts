/**
 * Epic 94 R1 A-01 — E2E probe that exercises the built CLI against each
 * S3 bucket-name invariant the `validateDesiredStateNode` guards.
 *
 * Regression covered: Epic 92 u.c.1 shipped the node + 28 unit tests but
 * left it out of `create-graph.ts`, so every rule (70-char length, IPv4
 * shape, `xn--` prefix, adjacent dots, `.-` adjacency) silently reached
 * CloudControl at apply time. This test drives the REAL built CLI in
 * `--output json` mode and asserts the stdout envelope is
 * `ok:false, error.code:"INVALID_DESIRED_STATE"`.
 *
 * Gated by `RUN_E2E=1` — plain `pnpm test` skips this file. Run via
 *   RUN_E2E=1 pnpm --filter assignee vitest run src/e2e/e94-bucket-name-validation.test.ts
 *
 * Requires:
 *   - `pnpm build` has produced `apps/cli/dist/index.js`.
 *   - `jq` is installed on the test runner (skip gracefully otherwise).
 *   - Real AWS credentials so the graph can bootstrap; the validator
 *     short-circuits BEFORE any CloudControl call, so no real resources
 *     are created by this test.
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
 * operator credentials via `...process.env`. Mirrors the pattern in
 * `e2e-plan.test.ts` — .env is the source of truth, shell vars are
 * stripped so nothing leaks in from the caller's session.
 */
function loadEnv() {
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
    timeout: 120_000,
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

function jqAvailable(): boolean {
  const res = spawnSync("jq", ["--version"], { encoding: "utf-8" });
  return res.status === 0;
}

describeE2E("Epic 94 R1 — bucket-name validation JSON envelope", () => {
  beforeAll(() => {
    loadEnv();
  });

  it("CLI dist exists (prerequisite — run `pnpm build` first)", () => {
    expect(fs.existsSync(CLI_DIST)).toBe(true);
  });

  it("jq is installed on the test runner", () => {
    expect(jqAvailable()).toBe(true);
  });

  // Each row tests a DISTINCT rule the validator guards, so regressions
  // in any one rule surface as a targeted failure rather than a single
  // "length check is on" coverage box.
  //
  // We deliberately pass the invalid bucket name via `--set
  // BucketName=<value>` rather than natural-language phrasing because
  // the plan_generator LLM is smart enough to silently canonicalise
  // obviously-invalid shapes (e.g. `192.168.1.1` → `192-168-1-1`) which
  // would short-circuit the regression probe. `--set` pipes the user's
  // value straight into `desiredState` via `presetFields`, bypassing
  // the LLM so the validator is the first (and only) thing that can
  // reject it.
  const cases: Array<{ label: string; bucketName: string }> = [
    { label: "70-char length", bucketName: "a".repeat(70) },
    { label: "IPv4 shape", bucketName: "192.168.1.1" },
    { label: "uppercase charset", bucketName: "CafeBucket" },
    { label: "xn-- IDN prefix", bucketName: "xn--example-bucket" },
    { label: "adjacent dots", bucketName: "app..logs..prod" },
  ];

  for (const { label, bucketName } of cases) {
    it(`${label} → stdout envelope ok:false + error.code:INVALID_DESIRED_STATE`, () => {
      if (!jqAvailable()) return;
      const { stdout, stderr, code } = runCli([
        "infra",
        "plan",
        "--output",
        "json",
        "--no-apply",
        "--set",
        `BucketName=${bucketName}`,
        "Create an S3 bucket",
      ]);

      // Exit status is non-zero — the plan failed.
      expect(code).not.toBe(0);
      // stderr carries the human `[ERROR] / [FIX]` render.
      expect(stderr.length).toBeGreaterThan(0);

      // stdout MUST be a single parseable JSON envelope with the
      // expected machine-readable code.
      const parsed = JSON.parse(stdout.trim());
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toBeDefined();
      expect(parsed.error.code).toBe("INVALID_DESIRED_STATE");
      expect(typeof parsed.error.message).toBe("string");
      // The [FIX] hint is user-visible guidance — make sure the
      // envelope carries it too so agent callers don't have to
      // parse stderr.
      expect(parsed.error.message.length).toBeGreaterThan(0);
    });
  }
});

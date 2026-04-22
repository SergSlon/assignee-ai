/**
 * Epic 94 R2 A-02 — E2E probe that exercises the built CLI to verify
 * a user-specified `named <x>` token is preserved on the Lambda
 * resource when the intent triggers a compound pattern such as
 * `LAMBDA_WITH_EXEC_ROLE`.
 *
 * Regression covered: Epic 92 Wave 2.a introduced pre-extraction of
 * asserted values in the intent-parser pattern-detect branch but
 * passed an empty string for `resourceType`, which caused
 * `resolveNameField` to return `null` and silently drop the user's
 * `named <x>` token. The fix (e94.R2) infers the primary resource
 * type from the detected PatternId and threads it through to
 * `extractAssertedValues`.
 *
 * Gated by `RUN_E2E=1` — plain `pnpm test` skips this file. Run via
 *   RUN_E2E=1 pnpm --filter assignee vitest run src/e2e/e94-lambda-compound-name.test.ts
 *
 * Requires:
 *   - `pnpm build` has produced `apps/cli/dist/index.js`.
 *   - `jq` is installed on the test runner.
 *   - AWS credentials so the graph can bootstrap; the plan returns
 *     BEFORE any CloudControl call, so no real resources are created.
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
 * operator credentials. Mirrors the pattern in e94-bucket-name-validation.
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

describeE2E("Epic 94 R2 — Lambda compound FunctionName preservation", () => {
  beforeAll(() => {
    loadEnv();
  });

  it("CLI dist exists (prerequisite — run `pnpm build` first)", () => {
    expect(fs.existsSync(CLI_DIST)).toBe(true);
  });

  it("jq is installed on the test runner", () => {
    expect(jqAvailable()).toBe(true);
  });

  // The intent phrasing "Create a lambda named my-alpha-fn" matches the
  // `lambda-with-exec-role` pattern keyword "create a lambda" so
  // pattern-detect fires — this is the code path the A-02 regression
  // lives on and it's deterministic offline (no live Bedrock call).
  it("FunctionName from intent lands on the Lambda plan (A-02 regression fix)", () => {
    if (!jqAvailable()) return;
    const { stdout, code } = runCli([
      "plan",
      "--output",
      "json",
      "--no-apply",
      "Create a lambda named my-alpha-fn",
    ]);

    expect(code).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.ok).toBe(true);
    expect(Array.isArray(parsed.plans)).toBe(true);

    // Find the Lambda plan inside the compound envelope.
    const lambdaPlan = parsed.plans.find(
      (p: { resourceType: string }) =>
        p.resourceType === "AWS::Lambda::Function",
    );
    expect(lambdaPlan).toBeDefined();
    // The core invariant: the user's `named my-alpha-fn` token must
    // land in desiredState.FunctionName. Pre-fix, this was
    // `assignee-lambda-fn-<hash>`.
    expect(lambdaPlan.desiredState.FunctionName).toBe("my-alpha-fn");
  });

  it("IAM Role companion is still present in the compound envelope (pattern integrity)", () => {
    if (!jqAvailable()) return;
    const { stdout } = runCli([
      "plan",
      "--output",
      "json",
      "--no-apply",
      "Create a lambda named my-alpha-fn",
    ]);

    const parsed = JSON.parse(stdout.trim());
    expect(parsed.ok).toBe(true);
    const iamRolePlan = parsed.plans.find(
      (p: { resourceType: string }) => p.resourceType === "AWS::IAM::Role",
    );
    // The companion exec role is still there (pattern detection
    // short-circuit was not affected by the fix).
    expect(iamRolePlan).toBeDefined();
  });
});

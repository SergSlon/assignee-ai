/**
 * Epic 94 R8 (A-05 + A-06) — E2E CLI probes for the S3 name extractor.
 *
 * Two separate regressions covered:
 *
 *   1. A-05 (HIGH): Unicode in the "named <x>" clause was silently
 *      truncated to the leading ASCII char, so R1's validator never
 *      saw the real non-ASCII value. Probe: intent with
 *      `named dögfood-ünicode` must produce an `ok:false` envelope
 *      whose message mentions `"non-ASCII"` (or `"ASCII"`).
 *
 *   2. A-06 (MED): Multi-word names silently dropped trailing tokens.
 *      Probe: intent with `named bad bucket name` must produce an
 *      `ok:true` envelope carrying at least one advisory whose
 *      `code === "NAME_REMAINDER_IGNORED"`.
 *
 * Gated by `RUN_E2E=1` — plain `pnpm test` skips this file. Run via
 *   RUN_E2E=1 pnpm --filter assignee vitest run src/e2e/e94-s3-name-unicode.test.ts
 *
 * Requires:
 *   - `pnpm build` has produced `apps/cli/dist/index.js`.
 *   - Real AWS credentials so the graph can bootstrap. (The unicode
 *     case short-circuits at intent-parser BEFORE any CloudControl
 *     call, so no real resources are created. The remainder case
 *     proceeds to plan generation — also read-only.)
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
 * `e94-bucket-name-validation.test.ts`.
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

describeE2E("Epic 94 R8 — S3 name extractor (unicode + multi-word)", () => {
  beforeAll(() => {
    loadEnv();
  });

  it("CLI dist exists (prerequisite — run `pnpm build` first)", () => {
    expect(fs.existsSync(CLI_DIST)).toBe(true);
  });

  it("A-05: unicode name `dögfood-ünicode` → ok:false + non-ASCII message", () => {
    const { stdout, stderr, code } = runCli([
      "infra",
      "plan",
      "--output",
      "json",
      "--no-apply",
      "Create an S3 bucket named dögfood-ünicode",
    ]);

    // Non-zero exit — plan failed.
    expect(code).not.toBe(0);
    // stderr carries the human [ERROR] / [FIX] render.
    expect(stderr.length).toBeGreaterThan(0);

    const parsed = JSON.parse(stdout.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBeDefined();
    // Message must explain the ASCII-only constraint so the user knows
    // exactly why the plan failed (the previous behaviour was a
    // generic 3-63 length error, which was misleading).
    expect(typeof parsed.error.message).toBe("string");
    expect(parsed.error.message).toMatch(/non-ASCII|ASCII/);
  });

  it("A-06: multi-word name `bad bucket name` → ok:true + NAME_REMAINDER_IGNORED advisory", () => {
    const { stdout, code } = runCli([
      "infra",
      "plan",
      "--output",
      "json",
      "--no-apply",
      "Create an S3 bucket named bad bucket name",
    ]);

    expect(code).toBe(0);
    const envelope = JSON.parse(stdout.trim());
    expect(envelope.ok).toBe(true);

    // Single-resource envelope shape: `plan` (singular). The advisory
    // lands on the plan payload (`envelope.plan.advisories`). Compound
    // plans would expose `envelope.plans[0].advisories`.
    expect(envelope.plan).toBeDefined();
    const advisories = envelope.plan.advisories as Array<{
      code: string;
      message: string;
      hint: string;
    }>;
    expect(Array.isArray(advisories)).toBe(true);
    const remainder = advisories.find(
      (a) => a.code === "NAME_REMAINDER_IGNORED",
    );
    expect(remainder).toBeDefined();
    // Tail tokens reported verbatim so the user can see exactly what
    // was dropped.
    expect(remainder!.message).toContain("bucket name");
    expect(remainder!.hint.length).toBeGreaterThan(0);

    // The captured name — just `bad` — lands on BucketName. Since "bad"
    // is a valid S3 name per AWS rules (length 3, charset clean), the
    // plan succeeds end-to-end.
    const desired = envelope.plan.desiredState as Record<string, unknown>;
    expect(desired["BucketName"]).toBe("bad");
  });
});

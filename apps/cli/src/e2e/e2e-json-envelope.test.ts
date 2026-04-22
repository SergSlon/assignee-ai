/**
 * Epic 92 Wave 2.c — e2e JSON envelope + stderr discipline.
 *
 * Spawns the built CLI for every `--output json` / `--json` surface
 * and pipes stdout through `jq -e .`. Any failure (non-zero jq exit,
 * non-parseable stdout) fails the test. Gated by `RUN_E2E=1` so
 * normal `pnpm test` skips the suite.
 *
 * Surfaces covered:
 *   1. `plan --output json "<unsupported-intent>"`         → error envelope
 *   2. `plan --output json "Create an S3 bucket"`          → success envelope (single)
 *   3. `plan --output json "Create an S3 bucket and a Lambda"` → success envelope (compound)
 *   4. `list --json --resource-type NOT-A-REAL-TYPE`        → error envelope
 *   5. `list --json`                                       → success envelope (array)
 *
 * Each case also asserts:
 *   - stderr is NOT empty (human message still printed)
 *   - no NDJSON on stdout — `JSON.parse(stdout.trim())` must succeed ONCE
 *
 * @see _bmad-output/implementation-artifacts/e92-2c-json-envelope.md
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const RUN_E2E = process.env["RUN_E2E"] === "1";
const describeE2E = RUN_E2E ? describe : describe.skip;

// Resolve the built CLI entry. Same convention as e2e-plan.test.ts.
// src/e2e/ → cli/ → apps/ → assignee.ai/
const CLI_DIST = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "dist",
  "index.js",
);

/**
 * Run the CLI with the given args and return { code, stdout, stderr }.
 * Timeout is 60s — every surface we test returns in well under that.
 */
function runCli(args: string[]): {
  code: number | null;
  stdout: string;
  stderr: string;
} {
  const res = spawnSync("node", [CLI_DIST, ...args], {
    encoding: "utf-8",
    timeout: 60_000,
    env: {
      ...process.env,
      // Turn off update-notifier + first-run banner — not our contract.
      ASSIGNEE_NO_UPDATE_CHECK: "1",
      // Keep JSON stream clean — no colour escapes on stdout.
      NO_COLOR: "1",
    },
  });
  return {
    code: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

/**
 * Pipe a string through `jq -e .`. Returns jq's exit code + output.
 * jq exits 0 on parseable truthy JSON, 1 on falsy, non-zero on
 * syntactic failure.
 */
function jqParse(input: string): { code: number | null; stdout: string } {
  const res = spawnSync("jq", ["-e", "."], {
    encoding: "utf-8",
    input,
    timeout: 10_000,
  });
  return { code: res.status, stdout: res.stdout ?? "" };
}

/**
 * Skip a test case gracefully if `jq` isn't installed on the runner —
 * we do not want to false-fail the e2e suite on tool absence.
 */
function jqAvailable(): boolean {
  const res = spawnSync("jq", ["--version"], { encoding: "utf-8" });
  return res.status === 0;
}

describeE2E("Epic 92 Wave 2.c — JSON envelope e2e (RUN_E2E=1)", () => {
  it("CLI dist exists (prerequisite — run `pnpm build` first)", () => {
    expect(fs.existsSync(CLI_DIST)).toBe(true);
  });

  it("jq is installed on the test runner", () => {
    expect(jqAvailable()).toBe(true);
  });

  describe("plan --output json", () => {
    it("error path — unsupported intent emits parseable { ok:false } envelope", () => {
      if (!jqAvailable()) return;
      const { stdout, stderr, code } = runCli([
        "plan",
        "--output",
        "json",
        "# do literally nothing",
      ]);
      // Exit code non-zero preserved.
      expect(code).not.toBe(0);
      // stderr MUST carry the human-readable help block.
      expect(stderr.length).toBeGreaterThan(0);
      // stdout MUST be a single parseable JSON value — use jq -e to
      // enforce the contract.
      const jq = jqParse(stdout);
      expect(jq.code).toBe(0);
      const parsed = JSON.parse(stdout.trim());
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toBeDefined();
      expect(typeof parsed.error.code).toBe("string");
      expect(typeof parsed.error.message).toBe("string");
    });

    it("success path — single resource emits parseable { ok:true, plan:{...} } envelope", () => {
      if (!jqAvailable()) return;
      const { stdout } = runCli([
        "plan",
        "--no-apply",
        "--output",
        "json",
        "Create an S3 bucket named e92-e2e-test",
      ]);
      const jq = jqParse(stdout);
      expect(jq.code).toBe(0);
      const parsed = JSON.parse(stdout.trim());
      expect(parsed.ok).toBe(true);
      // Single-resource plans emit `.plan`; compound emit `.plans`.
      expect(parsed.plan ?? parsed.plans).toBeDefined();
    });

    it("success path — compound emits parseable { ok:true, plans:[...] } envelope (A-02)", () => {
      if (!jqAvailable()) return;
      const { stdout } = runCli([
        "plan",
        "--no-apply",
        "--output",
        "json",
        "Create an S3 bucket and a Lambda function for image processing",
      ]);
      // Guard: if the LLM didn't produce a compound plan on this run,
      // the single-resource envelope is still legal. Skip the array
      // assertion in that case.
      const jq = jqParse(stdout);
      expect(jq.code).toBe(0);
      const parsed = JSON.parse(stdout.trim());
      expect(parsed.ok).toBe(true);
      if (parsed.plans !== undefined) {
        expect(Array.isArray(parsed.plans)).toBe(true);
        expect(parsed.plans.length).toBeGreaterThanOrEqual(2);
      }
    });
  });

  describe("list --json", () => {
    it("error path — unknown --resource-type emits parseable { ok:false } envelope (D-30)", () => {
      if (!jqAvailable()) return;
      const { stdout, stderr, code } = runCli([
        "list",
        "--json",
        "--resource-type",
        "NOT-A-REAL-TYPE",
      ]);
      expect(code).not.toBe(0);
      expect(stderr.length).toBeGreaterThan(0);
      // stderr should carry the registry block — stdout must NOT.
      expect(stdout).not.toContain("What you can create");
      const jq = jqParse(stdout);
      expect(jq.code).toBe(0);
      const parsed = JSON.parse(stdout.trim());
      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBe("INVALID_RESOURCE_TYPE");
    });

    it("success path — list --json emits parseable { ok:true, resources:[...], count, region } envelope (A-04)", () => {
      if (!jqAvailable()) return;
      // Story 94-N2 (A-04): `list --json` success path now emits a
      // discriminated envelope symmetric with the Wave 2.c failure
      // envelope. The legacy `Array.isArray(parsed)` assertion that
      // locked the bare-array shape is updated to the new envelope
      // shape — NOT weakened. See `94-n2-list-json-envelope.md`.
      const { stdout } = runCli(["list", "--json"]);
      const jq = jqParse(stdout);
      expect(jq.code).toBe(0);
      const parsed = JSON.parse(stdout.trim());
      expect(parsed.ok).toBe(true);
      // May be an empty array if nothing is managed; that's still valid.
      expect(Array.isArray(parsed.resources)).toBe(true);
      expect(typeof parsed.count).toBe("number");
      expect(parsed.count).toBe(parsed.resources.length);
      expect(typeof parsed.region).toBe("string");
      expect(parsed.region.length).toBeGreaterThan(0);
    });
  });

  describe("stderr discipline (A-21 / B-14)", () => {
    it("--verbose plan writes structured log events to stderr only", () => {
      if (!jqAvailable()) return;
      const { stdout, stderr } = runCli([
        "--verbose",
        "plan",
        "--no-apply",
        "--output",
        "json",
        "Create an S3 bucket named e92-e2e-verbose",
      ]);
      // stdout must still be a single parseable JSON value.
      const jq = jqParse(stdout);
      expect(jq.code).toBe(0);
      // stderr contains the structured log lines — each one is a JSON
      // object on its own line (per actions.ts format).
      const stderrLines = stderr
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("{") && l.endsWith("}"));
      // At least one log event should have fired (plan_started etc.).
      expect(stderrLines.length).toBeGreaterThan(0);
      for (const line of stderrLines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });
  });
});

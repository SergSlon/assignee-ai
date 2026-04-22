/**
 * Epic 94 Wave 2 Story N2 (A-04) — `assignee list --json` success
 * envelope.
 *
 * Before N2: `list --json` success path emitted a bare JSON array of
 * `ManagedResource` objects. Scripted consumers could not distinguish
 * `[]` (no resources managed in the region) from a broken call that
 * happened to serialise to `[]` — both were parseable, neither carried
 * a discriminator.
 *
 * After N2: success path emits a discriminated envelope symmetric
 * with the Wave 2.c failure envelope:
 *
 *   success → { ok:true, resources:[...], count, region }
 *   error   → { ok:false, error:{code, message, hint?} }
 *
 * `jq -e '.ok == true'` on the success path and `jq -e '.ok == false'`
 * on the error path both exit 0, and clients can switch on the single
 * `.ok` boolean without knowing anything else about the payload.
 *
 * This suite also locks the Wave 94.R7 error envelope invariant — the
 * rewrite must NOT regress the error path.
 *
 * Gated by `RUN_E2E=1` so normal `pnpm test` skips the suite.
 */
import { describe, it, expect } from "vitest";
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

/**
 * Pipe a string through `jq -e <filter>`. Returns jq's exit code.
 * jq exits 0 on parseable truthy JSON, 1 on falsy, non-zero on
 * syntactic failure.
 */
function jqCheck(input: string, filter: string): number | null {
  const res = spawnSync("jq", ["-e", filter], {
    encoding: "utf-8",
    input,
    timeout: 10_000,
  });
  return res.status;
}

function jqAvailable(): boolean {
  const res = spawnSync("jq", ["--version"], { encoding: "utf-8" });
  return res.status === 0;
}

describeE2E("Epic 94 N2 — list --json success envelope (RUN_E2E=1)", () => {
  it("CLI dist exists (prerequisite — run `pnpm build` first)", () => {
    expect(fs.existsSync(CLI_DIST)).toBe(true);
  });

  it("jq is installed on the test runner", () => {
    expect(jqAvailable()).toBe(true);
  });

  it("A-04: success envelope — ok:true, resources[], count, region", () => {
    if (!jqAvailable()) return;
    const { stdout, code } = runCli(["list", "--json"]);
    // `list` is read-only; success exit code is 0 regardless of count.
    expect(code).toBe(0);
    // Single-JSON-value contract (not NDJSON).
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.ok).toBe(true);
    expect(Array.isArray(parsed.resources)).toBe(true);
    expect(typeof parsed.count).toBe("number");
    expect(parsed.count).toBe(parsed.resources.length);
    expect(typeof parsed.region).toBe("string");
    expect(parsed.region.length).toBeGreaterThan(0);
    // Compound jq check — this is the acceptance probe from the story.
    const jqStatus = jqCheck(
      stdout,
      '.ok == true and (.resources | type == "array") and (.count | type == "number") and (.region | type == "string")',
    );
    expect(jqStatus).toBe(0);
  });

  it("A-04: success envelope carries NO `.error` field", () => {
    if (!jqAvailable()) return;
    const { stdout } = runCli(["list", "--json"]);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.ok).toBe(true);
    expect(parsed.error).toBeUndefined();
  });

  it("R7 regression guard: error envelope — ok:false, error.code", () => {
    if (!jqAvailable()) return;
    const { stdout, code } = runCli([
      "list",
      "--json",
      "--resource-type",
      "NOT-A-REAL",
    ]);
    // Error path preserves non-zero exit.
    expect(code).not.toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.ok).toBe(false);
    expect(typeof parsed.error.code).toBe("string");
    expect(parsed.error.code).toBe("INVALID_RESOURCE_TYPE");
    // Compound jq check — mirrors the story's error probe.
    const jqStatus = jqCheck(
      stdout,
      '.ok == false and (.error.code | type == "string")',
    );
    expect(jqStatus).toBe(0);
  });

  it("A-04: success and error envelopes are discriminable by `.ok` alone", () => {
    if (!jqAvailable()) return;
    const successOut = runCli(["list", "--json"]).stdout;
    const errorOut = runCli([
      "list",
      "--json",
      "--resource-type",
      "NOT-A-REAL",
    ]).stdout;
    // A single `.ok` check suffices for a scripted consumer.
    expect(jqCheck(successOut, ".ok == true")).toBe(0);
    expect(jqCheck(errorOut, ".ok == false")).toBe(0);
    // The OPPOSITE filter exits non-zero — the two envelopes are
    // mutually exclusive, not overlapping.
    expect(jqCheck(successOut, ".ok == false")).not.toBe(0);
    expect(jqCheck(errorOut, ".ok == true")).not.toBe(0);
  });

  it("A-04: --region is echoed in the success envelope", () => {
    if (!jqAvailable()) return;
    // Pick a region that's cheap + universally available and distinct
    // from the default, so we can assert the envelope echoes it
    // regardless of the operator's configured AWS_REGION.
    const explicit = "eu-west-1";
    const { stdout } = runCli(["list", "--json", "--region", explicit]);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.ok).toBe(true);
    expect(parsed.region).toBe(explicit);
  });
});

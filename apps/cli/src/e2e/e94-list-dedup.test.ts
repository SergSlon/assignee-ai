/**
 * Epic 94 Wave 1 Story R7 (D-02 + D-10) — `assignee list`
 * error-path stderr dedup.
 *
 * Before the fix: `list --resource-type <invalid>` printed the
 * 37-types registry hint grid TWICE on stderr — once inside the
 * `[CONTEXT]` block emitted by `renderError`, and once again via
 * Commander's top-level `Error: ${err.message}` fallback in
 * `apps/cli/src/index.ts` (the message embeds the grid).
 *
 * After the fix: `AssigneeError` carries an `alreadyRendered` flag
 * that the top-level `parseAsync.catch` checks; `list.ts` rethrows
 * with the flag set after calling `renderError`, so the Commander
 * fallback skips its duplicate print. The 37-types grid appears
 * EXACTLY ONCE on stderr.
 *
 * This suite also guards the Wave 2.c JSON envelope invariant — the
 * stdout payload for `--json` must still be a single parseable
 * `{ok:false, error:{...}}` envelope with zero extra output.
 *
 * Gated by `RUN_E2E=1` so normal `pnpm test` skips the suite. The
 * gate is the same convention as `e2e-json-envelope.test.ts`.
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

describeE2E("Epic 94 R7 — list --resource-type dedup (RUN_E2E=1)", () => {
  it("CLI dist exists (prerequisite — run `pnpm build` first)", () => {
    expect(fs.existsSync(CLI_DIST)).toBe(true);
  });

  it("D-02: 37-types registry grid appears EXACTLY ONCE on stderr", () => {
    const { stderr, code } = runCli([
      "admin",
      "list",
      "--resource-type",
      "NOT-A-REAL-TYPE",
    ]);
    expect(code).not.toBe(0);
    // Count unique-text markers of the registry grid. The header
    // line is stable across registry growth (only the count
    // changes), but the `(37 resource types)` literal is what the
    // regression report tracks. Keep both signal words so the test
    // stays meaningful even if the grid adds new groups later.
    const gridHeaderCount = (stderr.match(/resource types\):/g) ?? []).length;
    expect(gridHeaderCount).toBe(1);
    const whatCount = (stderr.match(/What you can create/g) ?? []).length;
    expect(whatCount).toBe(1);
  });

  it("D-02: headline line `Unknown --resource-type` renders exactly ONCE", () => {
    // Before the fix, the headline was printed three times on
    // stderr: `[ERROR] …`, first line of the `[CONTEXT]` block,
    // and finally `Error: …` (Commander's fallback). After the
    // fix: `[ERROR] …` once, CONTEXT prefix stripped (D-10), and
    // the Commander fallback suppressed (D-02).
    const { stderr } = runCli([
      "admin",
      "list",
      "--resource-type",
      "NOT-A-REAL-TYPE",
    ]);
    const headlineCount = (
      stderr.match(/Unknown --resource-type "NOT-A-REAL-TYPE"\./g) ?? []
    ).length;
    expect(headlineCount).toBe(1);
  });

  it("JSON envelope invariant (Wave 2.c) preserved on error path", () => {
    const { stdout, stderr, code } = runCli([
      "admin",
      "list",
      "--json",
      "--resource-type",
      "NOT-A-REAL-TYPE",
    ]);
    expect(code).not.toBe(0);
    // stderr still carries the grid (exactly once) — human message.
    const gridCount = (stderr.match(/resource types\):/g) ?? []).length;
    expect(gridCount).toBe(1);
    // stdout must be a single parseable envelope with no extra noise.
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("INVALID_RESOURCE_TYPE");
    expect(parsed.error.message).toContain(
      'Unknown --resource-type "NOT-A-REAL-TYPE"',
    );
    // stdout must NOT carry the [ERROR] prefix or registry text —
    // those live on stderr only.
    expect(stdout).not.toContain("[ERROR]");
    expect(stdout).not.toContain("What you can create");
  });

  it("exit code is preserved (non-zero) on INVALID_RESOURCE_TYPE", () => {
    // Safety check: the dedup fix must not accidentally swallow the
    // error — exit code must still be non-zero so downstream shells
    // and CI jobs see the failure.
    const { code } = runCli([
      "admin",
      "list",
      "--resource-type",
      "NOT-A-REAL-TYPE",
    ]);
    expect(code).not.toBe(0);
  });
});

/**
 * Epic 94 R6 (D-01) — E2E CLI probe: `assignee dev init` non-TTY guard.
 *
 * Regression: Epic 92 u.d shipped a non-TTY guard that emitted a
 * friendly `[ERROR]+[FIX]` envelope and exited 1 when the user piped
 * `assignee dev init` without supplying `--yes`. But the guard predicate
 * used `process.stdout.isTTY === false`, and Node actually reports
 * `isTTY === undefined` (NOT `false`) for streams that are pipes or
 * redirections. So the canonical CI invocation
 *   $ assignee dev init </dev/null
 * never tripped the guard — clack saw piped stdin, aborted the prompt
 * silently, and the CLI exited 0 without writing any config. Every CI
 * pipeline that invokes `assignee dev init` without `--yes` has been
 * silently broken since Epic 92 u.d landed.
 *
 * After R6: stdin from `/dev/null` → guard fires → exit 1 → stderr
 * contains both `[ERROR]` and `[FIX]` markers. `--yes` still bypasses
 * the guard.
 *
 * This test drives the REAL built CLI because only the spawned-process
 * layer actually has `isTTY === undefined` on a redirected stream — in
 * a unit test we can mock the values, but we cannot cause Node itself
 * to report `undefined`. The unit test in init.test.ts covers the
 * mocked branch; this test covers the wire behaviour.
 *
 * Gated by `RUN_E2E=1`. Run via:
 *   RUN_E2E=1 pnpm --filter assignee vitest run \
 *     src/e2e/e94-init-non-tty.test.ts
 *
 * Requires:
 *   - `pnpm build` produced `apps/cli/dist/index.js`.
 *   - NO AWS credentials needed — the guard fires before any AWS call.
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

/**
 * Spawn the CLI with stdin redirected from /dev/null — the exact
 * pattern a CI shell uses when it runs `assignee dev init < /dev/null` or
 * when the parent process has no stdin attached.
 */
function runInitWithPipedStdin(args: string[]): {
  code: number | null;
  stdout: string;
  stderr: string;
} {
  const devnull = fs.openSync("/dev/null", "r");
  try {
    const res = spawnSync("node", [CLI_DIST, "dev", "init", ...args], {
      encoding: "utf-8",
      timeout: 30_000,
      stdio: [devnull, "pipe", "pipe"],
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
  } finally {
    fs.closeSync(devnull);
  }
}

describeE2E("Epic 94 R6 — init non-TTY guard predicate (D-01)", () => {
  it("CLI dist exists (prerequisite — run `pnpm build` first)", () => {
    expect(fs.existsSync(CLI_DIST)).toBe(true);
  });

  it("init with stdin=/dev/null and no --yes exits non-zero", () => {
    const { code } = runInitWithPipedStdin([]);
    // The old predicate let this exit 0 silently. The fix makes it
    // exit 1 with an actionable envelope.
    expect(
      code,
      `expected non-zero exit when piping to non-TTY stdin; got code=${String(code)}`,
    ).toBe(1);
  });

  it("stderr carries [ERROR] and [FIX] envelope on the non-TTY path", () => {
    const { stderr } = runInitWithPipedStdin([]);
    expect(stderr).toContain("[ERROR] init requires a TTY OR --yes flag");
    expect(stderr).toContain("[FIX] Re-run with: assignee dev init --yes");
  });

  it("init with stdin=/dev/null AND --yes still proceeds (CI mode)", () => {
    // --yes must always bypass the guard, even under pipe redirection.
    // This is the supported CI pattern. We do NOT assert exit 0 here
    // because the downstream wizard may legitimately fail on missing
    // AWS config; we only assert that the `[ERROR] init requires a
    // TTY` envelope is absent — i.e. the guard did not fire.
    const { stderr } = runInitWithPipedStdin([
      "--yes",
      "--region",
      "us-east-1",
      "--auto-fix",
      "ask",
    ]);
    expect(stderr).not.toContain("init requires a TTY OR --yes flag");
  });
});

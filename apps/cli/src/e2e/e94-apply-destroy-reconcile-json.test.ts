/**
 * Epic 94 Wave 2 N4 (A-14 / D-08) — E2E probe for `--json` parity on
 * `apply` / `destroy` / `reconcile`.
 *
 * Gated by `RUN_E2E=1`. Spawns the built CLI (apps/cli/dist/index.js)
 * and asserts:
 *   1. `--json --help` exits 0 and lists the flag (registration probe).
 *   2. `destroy <invalid-arn> --yes --json` emits exactly one
 *      parseable JSON value with `ok === false` and a stable `.error.code`
 *      of type `string` — no real AWS call executes because the ARN is
 *      obviously wrong / does not exist. The exit code is non-zero.
 *   3. `reconcile --json` without credentials / managed resources still
 *      emits a parseable envelope (may be `{ok:true,operation:"reconcile"}`
 *      when no drifted resources, or `{ok:false,error:{...}}` when
 *      credentials are missing — both are legitimate, both parseable).
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const RUN_E2E = process.env["RUN_E2E"] === "1";
const describeE2E = RUN_E2E ? describe : describe.skip;

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

function jqAvailable(): boolean {
  const res = spawnSync("jq", ["--version"], { encoding: "utf-8" });
  return res.status === 0;
}

function jqParse(input: string): { code: number | null } {
  const res = spawnSync("jq", ["-e", "."], {
    encoding: "utf-8",
    input,
    timeout: 10_000,
  });
  return { code: res.status };
}

describeE2E(
  "Epic 94 N4 — apply/destroy/reconcile --json parity (RUN_E2E=1)",
  () => {
    it("CLI dist exists (run `pnpm build` first)", () => {
      expect(fs.existsSync(CLI_DIST)).toBe(true);
    });

    it("jq is installed on the test runner", () => {
      expect(jqAvailable()).toBe(true);
    });

    describe("flag registration", () => {
      for (const cmd of ["apply", "destroy", "reconcile"] as const) {
        it(`${cmd} --help exits 0 and lists --json`, () => {
          const { code, stdout, stderr } = runCli([cmd, "--help"]);
          expect(code).toBe(0);
          const helpText = stdout + stderr;
          expect(helpText).toContain("--json");
          expect(helpText).toContain("--output");
        });
      }
    });

    describe("destroy --json failure envelope", () => {
      it("invalid/nonexistent ARN with --yes --json emits parseable { ok:false } envelope", () => {
        if (!jqAvailable()) return;
        // Clearly non-existent bucket ARN (timestamp suffix guarantees
        // no real-world collision) and --yes to skip typed-name prompt.
        const arn = `arn:aws:s3:::nonexistent-e94-n4-${Date.now()}`;
        const { stdout, code } = runCli(["destroy", arn, "--yes", "--json"]);
        // Exit code must be non-zero — the destroy failed.
        expect(code).not.toBe(0);
        // stdout must be a single parseable JSON value.
        const jq = jqParse(stdout);
        expect(jq.code).toBe(0);
        const parsed = JSON.parse(stdout.trim());
        expect(parsed.ok).toBe(false);
        expect(parsed.error).toBeDefined();
        expect(typeof parsed.error.code).toBe("string");
        expect(typeof parsed.error.message).toBe("string");
      });
    });

    describe("reconcile --json envelope parseability", () => {
      it("reconcile --yes --json emits exactly one parseable JSON value", () => {
        if (!jqAvailable()) return;
        const { stdout } = runCli(["reconcile", "--yes", "--json"]);
        // The envelope may be success (no drifted resources / no
        // provisions) or failure (credentials missing). Either way:
        // one parseable JSON value on stdout.
        const jq = jqParse(stdout);
        expect(jq.code).toBe(0);
        const parsed = JSON.parse(stdout.trim());
        expect(typeof parsed.ok).toBe("boolean");
        if (parsed.ok === true) {
          expect(parsed.operation).toBe("reconcile");
        } else {
          expect(typeof parsed.error.code).toBe("string");
          expect(typeof parsed.error.message).toBe("string");
        }
      });
    });
  },
);

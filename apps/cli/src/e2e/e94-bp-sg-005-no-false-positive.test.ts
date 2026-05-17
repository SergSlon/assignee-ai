/**
 * Epic 94 R4 (B-02) — E2E CLI probe.
 *
 * Regression: `packages/best-practices/ec2/BP-SG-005.yaml` shipped with
 * `check_type: awareness`, which the awareness-filter treats as
 * "always fires". Every SG plan — regardless of port or CIDR — surfaced
 * a CRITICAL "RDP port 3389 open to 0.0.0.0/0" finding. Users trained
 * to ignore CRITICAL severity.
 *
 * After R4: rule carries `check_type: not_equals` +
 * `expected_value: "0.0.0.0/0:3389"`. The rule-runner parses the
 * `"<cidr>:<port>"` grammar and inspects the real ingress array.
 *
 * This test drives the REAL built CLI in `--output json` mode and
 * verifies the fix end-to-end against live LLM + MCP — the only
 * layer the unit tests do not cover.
 *
 * Gated by `RUN_E2E=1`. Run via:
 *   RUN_E2E=1 pnpm --filter assignee vitest run \
 *     src/e2e/e94-bp-sg-005-no-false-positive.test.ts
 *
 * Requires:
 *   - `pnpm build` produced `apps/cli/dist/index.js`.
 *   - Real AWS credentials; the graph bootstraps before planning.
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
 * operator credentials. Mirrors e94-sg-port-intent.
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

interface BpFinding {
  practiceId: string;
  severity: string;
}

function bpFindingsFor(stdout: string): BpFinding[] {
  const envelope = JSON.parse(stdout.trim()) as {
    ok: boolean;
    plan?: { bpFindings?: BpFinding[] };
  };
  return envelope.plan?.bpFindings ?? [];
}

describeE2E(
  "Epic 94 R4 — BP-SG-005 no longer a universal false positive (B-02)",
  () => {
    beforeAll(() => {
      loadEnv();
    });

    it("CLI dist exists (prerequisite — run `pnpm build` first)", () => {
      expect(fs.existsSync(CLI_DIST)).toBe(true);
    });

    it("port 443 from 0.0.0.0/0 → NO BP-SG-005 finding", () => {
      const { stdout, code } = runCli([
        "infra",
        "plan",
        "--output",
        "json",
        "--no-apply",
        "Create a security group allowing port 443 from 0.0.0.0/0",
      ]);
      expect(code).toBe(0);
      const hits = bpFindingsFor(stdout).filter(
        (f) => f.practiceId === "BP-SG-005",
      );
      expect(
        hits.length,
        `BP-SG-005 must NOT fire on non-RDP port; got ${JSON.stringify(hits)}`,
      ).toBe(0);
    });

    it("port 80 from 0.0.0.0/0 → NO BP-SG-005 finding (second non-RDP probe)", () => {
      const { stdout, code } = runCli([
        "infra",
        "plan",
        "--output",
        "json",
        "--no-apply",
        "Create a security group allowing port 80 from 0.0.0.0/0",
      ]);
      expect(code).toBe(0);
      const hits = bpFindingsFor(stdout).filter(
        (f) => f.practiceId === "BP-SG-005",
      );
      expect(
        hits.length,
        `BP-SG-005 must NOT fire on port 80; got ${JSON.stringify(hits)}`,
      ).toBe(0);
    });

    it("RDP from 0.0.0.0/0 → BP-SG-005 DOES fire (genuine exposure)", () => {
      const { stdout, code } = runCli([
        "infra",
        "plan",
        "--output",
        "json",
        "--no-apply",
        "Create a security group allowing RDP from 0.0.0.0/0",
      ]);
      expect(code).toBe(0);
      const hits = bpFindingsFor(stdout).filter(
        (f) => f.practiceId === "BP-SG-005",
      );
      expect(
        hits.length,
        `BP-SG-005 must fire on genuine RDP exposure; got ${JSON.stringify(hits)}`,
      ).toBe(1);
      expect(hits[0]!.severity).toBe("CRITICAL");
    });
  },
);

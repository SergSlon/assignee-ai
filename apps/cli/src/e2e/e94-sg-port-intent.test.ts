/**
 * Epic 94 R3 (B-01) — E2E CLI probe.
 *
 * Regression: the SG plugin used to hardcode
 *   defaults.SecurityGroupIngress = [{port 443}]
 * which clobbered the intent-parser output. Every "allowing port X" intent
 * collapsed to port 443 in the final desiredState, silently creating the
 * wrong security group.
 *
 * This test drives the REAL built CLI in `--output json` mode and asserts
 * that for each of port 22 / 3306 / 3389, the resulting plan's
 * `desiredState.SecurityGroupIngress[0].FromPort` matches the requested
 * port — not 443.
 *
 * Gated by `RUN_E2E=1` — plain `pnpm test` skips this file. Run via
 *   RUN_E2E=1 pnpm --filter assignee vitest run src/e2e/e94-sg-port-intent.test.ts
 *
 * Requires:
 *   - `pnpm build` has produced `apps/cli/dist/index.js`.
 *   - Real AWS credentials (the graph bootstraps before planning).
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
 * operator credentials via `...process.env`. Mirrors e94-bucket-name-validation.
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

describeE2E(
  "Epic 94 R3 — SG ingress routed from intent (B-01 regression)",
  () => {
    beforeAll(() => {
      loadEnv();
    });

    it("CLI dist exists (prerequisite — run `pnpm build` first)", () => {
      expect(fs.existsSync(CLI_DIST)).toBe(true);
    });

    // The regression covered three common ports that differ from the old
    // hardcoded default (443). If any of them comes back as 443, the
    // plugin-default-clobbers-intent bug has re-introduced itself.
    for (const port of [22, 3306, 3389]) {
      it(`intent "allowing port ${port}" → desiredState.SecurityGroupIngress[0].FromPort === ${port}`, () => {
        const { stdout, code } = runCli([
          "plan",
          "--output",
          "json",
          "--no-apply",
          `Create a security group allowing port ${port} from 0.0.0.0/0`,
        ]);

        expect(code).toBe(0);
        const envelope = JSON.parse(stdout.trim());
        expect(envelope.ok).toBe(true);
        // Single-resource plan envelope shape: `plan` (singular). Compound
        // intents use `plans` (array). This probe targets a bare SG, so
        // `plan` is the canonical field.
        expect(envelope.plan).toBeDefined();

        const desired = envelope.plan.desiredState as Record<string, unknown>;
        const ingress = desired["SecurityGroupIngress"] as
          | Array<Record<string, unknown>>
          | undefined;
        expect(ingress, "SecurityGroupIngress must be present").toBeDefined();
        expect(ingress!.length).toBeGreaterThanOrEqual(1);
        // The critical assertion: the user-requested port survived.
        expect(ingress![0]!["FromPort"]).toBe(port);
        expect(ingress![0]!["ToPort"]).toBe(port);
        // And it's NOT the old hardcoded 443 default.
        expect(ingress![0]!["FromPort"]).not.toBe(443);
      });
    }
  },
);

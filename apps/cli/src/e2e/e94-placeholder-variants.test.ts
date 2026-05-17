/**
 * Epic 94 Wave 3 N6 (B-04 / C-05 / C-06) — E2E probe: angle-bracket
 * placeholder IDs and the `--no-apply` downgrade.
 *
 * B-04 HIGH NEW: the placeholder-resource-id guard was blind to
 *   `subnet-<hex>` / `vpc-<id>` angle-bracket template tokens that the
 *   LLM occasionally emits when its context is cluttered with docs
 *   examples. The regex now catches any `<prefix>-<...>` shape.
 *
 * C-05 / C-06 HIGH PRE: a placeholder rejection under default mode
 *   was a hard failure AND under `--no-apply` (preview) mode, so
 *   operators could not even SEE the plan body to debug. Under
 *   `--no-apply` the same rejection is downgraded to a non-blocking
 *   advisory attached to `state.advisories`, and the plan renders.
 *
 * Gated by `RUN_E2E=1` — plain `pnpm test` skips this file. Run via
 *   RUN_E2E=1 pnpm --filter assignee vitest run \
 *     src/e2e/e94-placeholder-variants.test.ts
 */

import { describe, it, expect, beforeAll } from "vitest";
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
const ENV_PATH = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  ".env",
);

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

interface Envelope {
  ok: boolean;
  error?: { code?: string; message?: string; hint?: string };
  plan?: { resourceType?: string; desiredState?: unknown };
  plans?: Array<{ resourceType?: string; desiredState?: unknown }>;
}

function parseEnvelope(stdout: string): Envelope {
  return JSON.parse(stdout.trim()) as Envelope;
}

describeE2E(
  "Epic 94 N6 (B-04 / C-05 / C-06) — placeholder variants + --no-apply preview",
  () => {
    beforeAll(() => {
      loadEnv();
    });

    it("CLI dist exists (prerequisite — run `pnpm build` first)", () => {
      expect(fs.existsSync(CLI_DIST)).toBe(true);
    });

    // C-05 / C-06: `--no-apply` produces a preview envelope for RDS
    // even when the plan would have failed preflight. The core
    // acceptance: `ok: true`, plan shape present, envelope is a valid
    // JSON object. An RDS Postgres plan without `--set
    // MasterUserPassword` used to trip the sentinel-password guard
    // and return `ok: false` under `--no-apply`; after N6 the preview
    // still renders while the apply path stays fail-closed.
    it("`--no-apply` previews an RDS postgres plan end-to-end without blocking", () => {
      const { stdout, code } = runCli([
        "infra",
        "plan",
        "--output",
        "json",
        "--no-apply",
        "Create an RDS postgres db",
      ]);

      expect(
        code,
        `expected exit 0; got code=${code}; stdout head=${stdout.slice(
          0,
          400,
        )}`,
      ).toBe(0);

      const envelope = parseEnvelope(stdout);
      expect(envelope.ok).toBe(true);

      // Envelope shape may be single (`.plan`) or compound
      // (`.plans[0]`). Accept either.
      const firstPlan = envelope.plan ?? envelope.plans?.[0];
      expect(firstPlan).toBeDefined();
      expect(firstPlan!.resourceType).toBe("AWS::RDS::DBInstance");
    });

    // B-04: a subnet plan whose desiredState ended up with an angle-
    // bracket placeholder (`subnet-<hex>`) must be REJECTED under the
    // default mode so the LLM's hallucinated ID never reaches AWS.
    //
    // We exercise this by forcing a subnet plan with a legacy-shaped
    // but docs-example VpcId (`vpc-12345678`); the placeholder-
    // resource-id guard fires on the same code path as it would for
    // the angle-bracket variant covered in unit tests. The extra
    // guarantee from the regex extension is carried by the dedicated
    // unit test suite in
    // `packages/core/src/graph/nodes/preflight-guard/guards/
    //  placeholder-resource-id.test.ts`, which this probe
    // complements at the CLI boundary.
    it("default mode (no `--no-apply`) rejects a docs-example VpcId placeholder", () => {
      const { stdout, code } = runCli([
        "infra",
        "plan",
        "--output",
        "json",
        "Create a subnet with VpcId vpc-12345678 and CidrBlock 10.0.1.0/24",
      ]);

      // Non-zero exit is acceptable — we just need the envelope on
      // stdout to be a valid ok:false with a placeholder message.
      expect(code).not.toBe(0);
      const envelope = parseEnvelope(stdout);
      expect(envelope.ok).toBe(false);
      // Message may live under several codes depending on which
      // guard fires first (`placeholder-resource-id` /
      // `UNSUPPORTED_RESOURCE`). We just assert the error is real
      // and mentions either "placeholder" or the VPC ID — both are
      // load-bearing signals that the guard blocked the plan.
      const msg = (envelope.error?.message ?? "").toLowerCase();
      expect(
        msg.includes("placeholder") ||
          msg.includes("vpc-12345678") ||
          msg.includes("does not exist"),
      ).toBe(true);
    });
  },
);

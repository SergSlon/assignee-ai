/**
 * Epic 94 N1 (B-03) — E2E probe: natural phrasing routes a VPC
 * intent to the `vpc-public-only` compound pattern.
 *
 * Background: Epic 92 Wave 1 locked in that bare `"Create a VPC"`
 * returns the single-resource `AWS::EC2::VPC` (no surprise NAT
 * gateway). Wave 2.b added `vpcPublicOnlyPattern` for the
 * cost-sensitive public-only VPC compound, but its keyword matcher
 * required contiguous substrings like `"vpc public subnets only"`
 * and therefore missed the natural phrasing `"Create a VPC with
 * public subnets only"` (inserted `"with"` breaks contiguity).
 *
 * After N1: the natural phrasing routes to the public-only compound
 * (VPC + 2 subnets + IGW + attachment + public RT + route + 2
 * associations = 9 resources), and the bare `"Create a VPC"` still
 * returns the single VPC resource.
 *
 * Gated by `RUN_E2E=1` — plain `pnpm test` skips this file. Run via
 *   RUN_E2E=1 pnpm --filter assignee vitest run \
 *     src/e2e/e94-vpc-public-only.test.ts
 *
 * Requires:
 *   - `pnpm build` has produced `apps/cli/dist/index.js`.
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
 * operator credentials. Mirrors the pattern in e94-lambda-compound-name.
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

/**
 * Parse the stdout of a `plan --output json` invocation. The success
 * envelope shape (Wave 2.c) is `{ ok: true, plans: [...] }`. Some
 * success-path code paths may also emit a single-resource
 * `{ ok: true, plan: {...} }` shape — normalize both to an array so
 * the rest of the test is shape-agnostic.
 */
function parseEnvelope(stdout: string): {
  ok: boolean;
  plans: Array<{ resourceType: string; desiredState?: unknown }>;
} {
  const parsed = JSON.parse(stdout.trim()) as {
    ok: boolean;
    plans?: Array<{ resourceType: string; desiredState?: unknown }>;
    plan?: { resourceType: string; desiredState?: unknown };
  };
  const plans =
    parsed.plans ?? (parsed.plan !== undefined ? [parsed.plan] : []);
  return { ok: parsed.ok, plans };
}

describeE2E(
  "Epic 94 N1 (B-03) — VPC public-only natural phrasing routes to compound",
  () => {
    beforeAll(() => {
      loadEnv();
    });

    it("CLI dist exists (prerequisite — run `pnpm build` first)", () => {
      expect(fs.existsSync(CLI_DIST)).toBe(true);
    });

    // Positive probe: natural phrasing produces the public-only
    // compound. The public-only compound contains the 4 distinctive
    // resource types not present in a bare-VPC plan: IGW, Subnet,
    // RouteTable, Route. Checking IGW + Subnet together is sufficient
    // and matches the caller-provided acceptance probe.
    it("'Create a VPC with public subnets only' routes to the public-only compound", () => {
      const { stdout, code } = runCli([
        "plan",
        "--output",
        "json",
        "--no-apply",
        "Create a VPC with public subnets only",
      ]);

      expect(
        code,
        `expected exit 0; got code=${code}; stdout head=${stdout.slice(0, 400)}`,
      ).toBe(0);

      const { ok, plans } = parseEnvelope(stdout);
      expect(ok).toBe(true);
      expect(Array.isArray(plans)).toBe(true);

      const resourceTypes = plans.map((p) => p.resourceType);

      // Public-only compound hallmarks: IGW + public subnet.
      expect(resourceTypes).toContain("AWS::EC2::InternetGateway");
      expect(resourceTypes).toContain("AWS::EC2::Subnet");
      // And the base VPC is still there.
      expect(resourceTypes).toContain("AWS::EC2::VPC");
      // NOT the full compound — no NAT Gateway should be present (it
      // only lives in vpcNetworkingPattern, which must NOT have fired).
      expect(resourceTypes).not.toContain("AWS::EC2::NatGateway");
    });

    // Bare VPC regression: Epic 92 Wave 2.b B-05 locked this in. The
    // N1 keyword expansion must not regress it — a bare intent with
    // no public-only cue must still produce the single-resource VPC.
    it("'Create a VPC' (bare) still returns a single-resource VPC plan", () => {
      const { stdout, code } = runCli([
        "plan",
        "--output",
        "json",
        "--no-apply",
        "Create a VPC",
      ]);

      expect(
        code,
        `expected exit 0; got code=${code}; stdout head=${stdout.slice(0, 400)}`,
      ).toBe(0);

      const { ok, plans } = parseEnvelope(stdout);
      expect(ok).toBe(true);
      expect(plans).toHaveLength(1);
      expect(plans[0]?.resourceType).toBe("AWS::EC2::VPC");
    });
  },
);

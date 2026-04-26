/**
 * Story R9b-01 — E2E compound 2/11 gap: VPC public-only
 *
 * Closes the gap identified in acquisition-dd-top100.md §P036: the
 * compound-pattern E2E test grid was missing coverage for the
 * `vpc-public-only` pattern.
 *
 * Background: Epic 92 Wave 1 locked in that bare `"Create a VPC"` returns
 * the single-resource AWS::EC2::VPC.  Wave 2.b added `vpcPublicOnlyPattern`
 * for the cost-sensitive public-only VPC compound.  Epic 94 N1 (B-03)
 * expanded the keyword set so natural phrasings like
 * `"Create a VPC with public subnets only"` also match.
 *
 * Test structure
 * ──────────────
 * SECTION A (always runs, no AWS required): unit-level verification
 *   that the intent → compound-dispatcher → resource-list path is
 *   correct.  Uses the real pattern and dispatcher from
 *   @assignee/core — no CLI spawn, no LLM call.
 *
 *   A-1: keyword detection — "vpc public subnets only" detects to the
 *        vpc-public-only pattern; bare "Create a VPC" does NOT match
 *        the public-only compound (avoids NAT-gateway surprise).
 *   A-2: compoundDispatcherNode expands vpc-public-only to exactly 9
 *        resources in canonical dependency order; first resource is VPC;
 *        no NAT Gateway or private subnet in the queue.
 *   A-3: every resource in the pattern has a defaultOptions entry
 *        containing its expected desiredState fields; in particular the
 *        public route targets the IGW (0.0.0.0/0 → IGW).
 *
 * SECTION B (gated by RUN_E2E=1 — requires real AWS credentials):
 *   full CLI smoke-tests spawned against the built dist/index.js.
 *
 *   B-1: prerequisite — CLI dist exists.
 *   B-2: `plan --output json "Create a VPC with public subnets only"`
 *        returns ok:true with AWS::EC2::InternetGateway and
 *        AWS::EC2::Subnet in the resource list, but WITHOUT a NatGateway.
 *   B-3: bare `"Create a VPC"` still returns a single-resource VPC plan
 *        (regression guard — Epic 92 Wave 2.b B-05).
 *
 * Run modes
 * ─────────
 * Section A: always runs — `pnpm test`, `pnpm -r test:coverage`.
 * Section B: `RUN_E2E=1 pnpm --filter assignee vitest run \
 *             src/e2e/e94-vpc-public-only.test.ts`
 */

import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  defaultPatternRegistry,
  vpcPublicOnlyPattern,
  ExecutionMode,
  ExecutionStatus,
} from "@assignee/core";
import { compoundDispatcherNode, type AgentState } from "@assignee/core/graph";

// ─── Section B helpers (CLI spawn, RUN_E2E=1) ────────────────────────────────

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
 * operator credentials.  Mirrors the pattern in e94-lambda-compound-name.
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
 * Parse the stdout of a `plan --output json` invocation and normalise
 * both the single-resource `{ ok, plan }` and compound `{ ok, plans }`
 * shapes to a uniform array.
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

/** Minimal AgentState factory for the compound-dispatcher unit tests. */
function makeState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    userIntent: "Create a VPC with public subnets only",
    runId: "r9b-vpc-public-test-001",
    executionMode: ExecutionMode.PLAN,
    resourceType: "",
    executionStatus: ExecutionStatus.PENDING,
    preflightPassed: true,
    preflightErrors: [],
    preflightMode: "local",
    messages: [],
    ...overrides,
  } as AgentState;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION A — Unit-level mock-mode tests (always run, no AWS required)
// ═══════════════════════════════════════════════════════════════════════════════

describe("P036 VPC public-only compound — Section A: mock-mode unit verification", () => {
  // A-1: keyword detection
  it("A-1: 'vpc public subnets only' keyword-detects to vpc-public-only; bare 'Create a VPC' does NOT match the public-only compound", () => {
    // Explicit public-only keyword cue → vpc-public-only compound
    const detected = defaultPatternRegistry.detect(
      "Create a VPC with public subnets only",
    );
    expect(detected?.patternId).toBe("vpc-public-only");

    // Additional keyword variants from the pattern's keyword list
    const detectedByCheap = defaultPatternRegistry.detect("cheap vpc");
    expect(detectedByCheap?.patternId).toBe("vpc-public-only");

    const detectedByNoNat = defaultPatternRegistry.detect(
      "Create a vpc without nat",
    );
    expect(detectedByNoNat?.patternId).toBe("vpc-public-only");

    // Bare intent — must NOT resolve to the public-only compound
    // (Epic 92 Wave 2.b B-05 invariant: no surprise NAT-gateway cost).
    const bareVpc = defaultPatternRegistry.detect("Create a VPC");
    expect(bareVpc?.patternId).not.toBe("vpc-public-only");
  });

  // A-2: compound dispatcher expansion
  it("A-2: compoundDispatcherNode expands vpc-public-only to 9 resources; first is AWS::EC2::VPC; no NatGateway in queue", async () => {
    const state = makeState({ resourcePattern: vpcPublicOnlyPattern });
    const result = await compoundDispatcherNode(state);

    // 9 resources: VPC + 2 subnets + IGW + IGW_ATTACHMENT + RT + Route + 2 RT_ASSOC
    expect(result.resourceQueue).toHaveLength(9);
    expect(result.currentResourceIndex).toBe(0);
    expect(result.completedResources).toEqual([]);
    expect(result.desiredState).toBeUndefined();

    // First resource in dependency order is the VPC itself
    expect(result.resourceType).toBe("AWS::EC2::VPC");
    expect(result.resourceQueue?.[0]?.resourceId).toBe("vpc");

    // Queue preserves dependency order (flat left-to-right)
    const expectedIds = vpcPublicOnlyPattern.dependencyOrder.flat();
    const queueIds = result.resourceQueue!.map((r) => r.resourceId);
    expect(queueIds).toEqual(expectedIds);

    // The public-only variant must NOT include a NatGateway or EIP
    // (these are the cost-bearing resources that the pattern deliberately omits)
    const queueTypes = result.resourceQueue!.map((r) => r.resourceType);
    expect(queueTypes).not.toContain("AWS::EC2::NatGateway");
    expect(queueTypes).not.toContain("AWS::EC2::EIP");

    // Must contain the four hallmark public-only types
    expect(queueTypes).toContain("AWS::EC2::VPC");
    expect(queueTypes).toContain("AWS::EC2::Subnet");
    expect(queueTypes).toContain("AWS::EC2::InternetGateway");
    expect(queueTypes).toContain("AWS::EC2::RouteTable");

    // Every entry carries a valid resourceType string
    for (const entry of result.resourceQueue!) {
      expect(entry.resourceType).toBeTruthy();
      expect(entry.resourceType).toContain("::");
    }
  });

  // A-3: defaultOptions entries and key desiredState fields
  it("A-3: every resource has a defaultOptions entry; public route uses DestinationCidrBlock=0.0.0.0/0 toward IGW", () => {
    // All 9 resources must have a defaultOptions entry
    for (const resource of vpcPublicOnlyPattern.resourceList) {
      expect(
        vpcPublicOnlyPattern.defaultOptions[resource.resourceId],
        `resource ${resource.resourceId} missing defaultOptions entry`,
      ).toBeDefined();
    }

    // VPC uses the expected CIDR block with DNS support enabled
    const vpcDefaults = vpcPublicOnlyPattern.defaultOptions["vpc"] as Record<
      string,
      unknown
    >;
    expect(vpcDefaults["CidrBlock"]).toBe("10.0.0.0/16");
    expect(vpcDefaults["EnableDnsSupport"]).toBe(true);
    expect(vpcDefaults["EnableDnsHostnames"]).toBe(true);

    // Public subnets: MapPublicIpOnLaunch must be true for instances
    // to get public IPs without explicit assignment
    const subnet1Defaults = vpcPublicOnlyPattern.defaultOptions[
      "public-subnet-1"
    ] as Record<string, unknown>;
    expect(subnet1Defaults["MapPublicIpOnLaunch"]).toBe(true);

    const subnet2Defaults = vpcPublicOnlyPattern.defaultOptions[
      "public-subnet-2"
    ] as Record<string, unknown>;
    expect(subnet2Defaults["MapPublicIpOnLaunch"]).toBe(true);

    // Public route: DestinationCidrBlock must be the default route
    // (0.0.0.0/0) — this is the hallmark of internet-accessible subnets
    const routeDefaults = vpcPublicOnlyPattern.defaultOptions[
      "public-route"
    ] as Record<string, unknown>;
    expect(routeDefaults["DestinationCidrBlock"]).toBe("0.0.0.0/0");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION B — RUN_E2E=1 CLI smoke tests (gated)
// ═══════════════════════════════════════════════════════════════════════════════

describeE2E(
  "P036 VPC public-only compound — Section B: CLI smoke tests (RUN_E2E=1)",
  () => {
    beforeAll(() => {
      loadEnv();
    });

    it("B-1: CLI dist exists (prerequisite — run `pnpm build` first)", () => {
      expect(fs.existsSync(CLI_DIST)).toBe(true);
    });

    // Positive probe: natural phrasing produces the public-only compound.
    // The public-only compound contains the 4 distinctive resource types
    // not present in a bare-VPC plan: IGW, Subnet, RouteTable, Route.
    // Checking IGW + Subnet together is sufficient per acceptance probe.
    it("B-2: 'Create a VPC with public subnets only' routes to the public-only compound (has IGW + Subnet; no NatGateway)", () => {
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

      // Public-only compound hallmarks: IGW + public subnet
      expect(resourceTypes).toContain("AWS::EC2::InternetGateway");
      expect(resourceTypes).toContain("AWS::EC2::Subnet");
      // And the base VPC is still there
      expect(resourceTypes).toContain("AWS::EC2::VPC");
      // NOT the full compound — no NAT Gateway should be present (it
      // only lives in vpcNetworkingPattern, which must NOT have fired)
      expect(resourceTypes).not.toContain("AWS::EC2::NatGateway");
    });

    // Bare VPC regression: Epic 92 Wave 2.b B-05 locked this in.
    // The N1 keyword expansion must not regress it — a bare intent with
    // no public-only cue must still produce the single-resource VPC.
    it("B-3: 'Create a VPC' (bare) still returns a single-resource VPC plan", () => {
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

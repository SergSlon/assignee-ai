/**
 * Story R9b-01 — E2E compound 2/11 gap: WebSocket API
 *
 * Closes the gap identified in acquisition-dd-top100.md §P036: the
 * compound-pattern E2E test grid was missing coverage for the
 * `websocket-api` pattern.
 *
 * Test structure
 * ──────────────
 * SECTION A (always runs, no AWS required): unit-level verification
 *   that the intent → compound-dispatcher → resource-list path is
 *   correct.  Uses the real pattern and dispatcher from
 *   @assignee/core — no CLI spawn, no LLM call.
 *
 *   A-1: keyword detection — "Create a websocket api" detects to
 *        PatternId.WEBSOCKET_API; "Create a websocket-api pattern"
 *        literal-matches the same pattern; HTTP-only intents do NOT
 *        match.
 *   A-2: compoundDispatcherNode expands websocket-api to exactly 12
 *        resources in canonical dependency order; first resource is
 *        the IAM execution role.
 *   A-3: every resource in the pattern has a defaultOptions entry
 *        containing its expected desiredState fields (ProtocolType,
 *        RouteSelectionExpression, StageName, RouteKey, etc.).
 *
 * SECTION B (gated by RUN_E2E=1 — requires real AWS credentials):
 *   full CLI smoke-tests spawned against the built dist/index.js.
 *
 *   B-1: prerequisite — CLI dist exists.
 *   B-2: `plan --output json "Create a websocket-api"` returns a
 *        parseable JSON envelope with ok:true, ≥12 resources,
 *        ProtocolType=WEBSOCKET, RouteSelectionExpression=$request.body.action.
 *   B-3: companion resources carry `provisionable: false`; exactly 3
 *        are provisionable (IAM role + Lambda + LogGroup).
 *
 * Run modes
 * ─────────
 * Section A: always runs — `pnpm test`, `pnpm -r test:coverage`.
 * Section B: `RUN_E2E=1 pnpm --filter assignee vitest run \
 *             src/e2e/e94-websocket-render.test.ts`
 */

import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  defaultPatternRegistry,
  PatternId,
  ExecutionMode,
  ExecutionStatus,
  type ArchitecturePattern,
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
}

function runCli(args: string[]): {
  code: number | null;
  stdout: string;
  stderr: string;
} {
  const res = spawnSync("node", [CLI_DIST, ...args], {
    encoding: "utf-8",
    timeout: 120_000,
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
 * Walk an arbitrary JSON value and collect every value for a named
 * field.  Used to verify `ProtocolType: "WEBSOCKET"` is reachable
 * somewhere in the CLI envelope without knowing its exact shape.
 */
function collectFieldValues(value: unknown, field: string): unknown[] {
  const out: unknown[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const item of v) walk(item);
      return;
    }
    if (v && typeof v === "object") {
      const obj = v as Record<string, unknown>;
      if (field in obj) out.push(obj[field]);
      for (const nested of Object.values(obj)) walk(nested);
    }
  };
  walk(value);
  return out;
}

/** Minimal AgentState factory for the compound-dispatcher unit tests. */
function makeState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    userIntent: "Create a websocket-api",
    runId: "r9b-websocket-test-001",
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

describe("P036 WebSocket API compound — Section A: mock-mode unit verification", () => {
  // A-1: keyword detection
  it("A-1: keyword/literal detection routes to PatternId.WEBSOCKET_API; HTTP intents do NOT match", () => {
    const detectedByKeyword = defaultPatternRegistry.detect(
      "Create a websocket api",
    );
    expect(detectedByKeyword?.patternId).toBe(PatternId.WEBSOCKET_API);

    // Pattern-ID literal fast-path: the pattern-ID string embedded in
    // the intent bypasses negativeKeywords and hits the registry directly.
    const detectedByLiteral = defaultPatternRegistry.detect(
      "Create a websocket-api pattern",
    );
    expect(detectedByLiteral?.patternId).toBe(PatternId.WEBSOCKET_API);

    // Regression guard: a plain HTTP serverless-api intent must NOT
    // match the websocket pattern.
    const httpDetected = defaultPatternRegistry.detect(
      "Create an http serverless api",
    );
    expect(httpDetected?.patternId).not.toBe(PatternId.WEBSOCKET_API);
  });

  // A-2: compound dispatcher expansion
  it("A-2: compoundDispatcherNode expands websocket-api to 12 resources; first is IAM execution role", async () => {
    const pattern = defaultPatternRegistry.get(
      PatternId.WEBSOCKET_API,
    ) as ArchitecturePattern;
    expect(pattern).toBeDefined();
    expect(pattern.resourceList).toHaveLength(12);

    const state = makeState({ resourcePattern: pattern });
    const result = await compoundDispatcherNode(state);

    expect(result.resourceQueue).toHaveLength(12);
    expect(result.currentResourceIndex).toBe(0);
    expect(result.completedResources).toEqual([]);
    // plan-generator will build desiredState from defaultOptions
    expect(result.desiredState).toBeUndefined();

    // First resource in dependency order is the IAM execution role
    expect(result.resourceType).toBe("AWS::IAM::Role");
    expect(result.resourceQueue?.[0]?.resourceId).toBe("iam-execution-role");

    // Queue preserves dependency order (flat left-to-right)
    const expectedIds = pattern.dependencyOrder.flat();
    const queueIds = result.resourceQueue!.map((r) => r.resourceId);
    expect(queueIds).toEqual(expectedIds);

    // Every entry carries a valid resourceType string
    for (const entry of result.resourceQueue!) {
      expect(entry.resourceType).toBeTruthy();
      expect(entry.resourceType).toContain("::");
    }
  });

  // A-3: desiredState fields from pattern defaultOptions
  it("A-3: every resource has a defaultOptions entry; API has ProtocolType=WEBSOCKET and canonical RouteSelectionExpression", () => {
    const pattern = defaultPatternRegistry.get(
      PatternId.WEBSOCKET_API,
    ) as ArchitecturePattern;

    // Every resource must have a defaultOptions entry (no silent
    // omissions).
    for (const resource of pattern.resourceList) {
      expect(
        pattern.defaultOptions[resource.resourceId],
        `resource ${resource.resourceId} missing defaultOptions entry`,
      ).toBeDefined();
    }

    // Key load-bearing field assertions on the WebSocket API resource.
    // These fields are plain strings (not marker tokens) so they are
    // directly readable from defaultOptions without marker substitution.
    const apiDefaults = pattern.defaultOptions["websocket-api"] as Record<
      string,
      unknown
    >;
    expect(apiDefaults["ProtocolType"]).toBe("WEBSOCKET");
    expect(apiDefaults["RouteSelectionExpression"]).toBe(
      "$request.body.action",
    );

    // Stage name and AutoDeploy
    const stageDefaults = pattern.defaultOptions["default-stage"] as Record<
      string,
      unknown
    >;
    expect(stageDefaults["StageName"]).toBe("production");
    expect(stageDefaults["AutoDeploy"]).toBe(true);

    // Each route carries its canonical WebSocket route key
    const routeCases = [
      { id: "connect-route", key: "$connect" },
      { id: "disconnect-route", key: "$disconnect" },
      { id: "default-route", key: "$default" },
    ];
    for (const { id, key } of routeCases) {
      const routeDefaults = pattern.defaultOptions[id] as Record<
        string,
        unknown
      >;
      expect(
        routeDefaults["RouteKey"],
        `route ${id} must have RouteKey ${key}`,
      ).toBe(key);
    }

    // Integrations all declare AWS_PROXY type
    for (const id of [
      "connect-integration",
      "disconnect-integration",
      "default-integration",
    ]) {
      const intDefaults = pattern.defaultOptions[id] as Record<string, unknown>;
      expect(
        intDefaults["IntegrationType"],
        `integration ${id} must be AWS_PROXY`,
      ).toBe("AWS_PROXY");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION B — RUN_E2E=1 CLI smoke tests (gated)
// ═══════════════════════════════════════════════════════════════════════════════

describeE2E(
  "P036 WebSocket API compound — Section B: CLI smoke tests (RUN_E2E=1)",
  () => {
    beforeAll(() => {
      loadEnv();
    });

    it("B-1: CLI dist exists (prerequisite — run `pnpm build` first)", () => {
      expect(fs.existsSync(CLI_DIST)).toBe(true);
    });

    it("B-2: plan --output json 'Create a websocket-api' produces parseable envelope with ≥12 resources, ProtocolType=WEBSOCKET, RouteSelectionExpression=$request.body.action", () => {
      const { stdout, code, stderr } = runCli([
        "plan",
        "--no-apply",
        "--output",
        "json",
        "Create a websocket-api",
      ]);

      expect(
        stdout.trim().length,
        `stdout must carry the envelope. stderr:\n${stderr.slice(0, 400)}`,
      ).toBeGreaterThan(0);

      let parsed: unknown;
      expect(
        () => {
          parsed = JSON.parse(stdout.trim());
        },
        `stdout must be single parseable JSON. got:\n${stdout.slice(0, 800)}`,
      ).not.toThrow();

      const env = parsed as {
        ok: boolean;
        plan?: unknown;
        plans?: unknown[];
        error?: { code: string; message: string };
      };
      expect(
        env.ok,
        `envelope must be ok:true. error: ${JSON.stringify(env.error)}`,
      ).toBe(true);

      const planCount =
        (env.plans?.length ?? 0) + (env.plan !== undefined ? 1 : 0);
      expect(
        planCount,
        `WebSocket compound must render all 12 resources; got ${planCount}`,
      ).toBeGreaterThanOrEqual(12);

      const protocolTypes = collectFieldValues(parsed, "ProtocolType");
      expect(
        protocolTypes,
        `ProtocolType values found: ${JSON.stringify(protocolTypes)}`,
      ).toContain("WEBSOCKET");

      const routeSelections = collectFieldValues(
        parsed,
        "RouteSelectionExpression",
      );
      expect(
        routeSelections,
        `RouteSelectionExpression values: ${JSON.stringify(routeSelections)}`,
      ).toContain("$request.body.action");

      expect(code).toBe(0);
    });

    it("B-3: companion resources carry provisionable:false; exactly 3 are provisionable (IAM role + Lambda + LogGroup)", () => {
      const { stdout } = runCli([
        "plan",
        "--no-apply",
        "--output",
        "json",
        "Create a websocket-api",
      ]);
      const env = JSON.parse(stdout.trim()) as {
        ok: boolean;
        plans?: Array<{ provisionable?: boolean }>;
        plan?: { provisionable?: boolean };
      };
      expect(env.ok).toBe(true);
      const entries = env.plans ?? (env.plan !== undefined ? [env.plan] : []);
      expect(entries.length).toBeGreaterThanOrEqual(12);
      const provisionableCount = entries.filter(
        (e) => e.provisionable === true,
      ).length;
      const companionCount = entries.filter(
        (e) => e.provisionable === false,
      ).length;
      // 3 provisionable (IAM role + Lambda + LogGroup)
      // 9 display-only companions (API + 3 Integrations + 3 Routes + Stage + Permission)
      expect(provisionableCount).toBe(3);
      expect(companionCount).toBe(9);
    });
  },
);

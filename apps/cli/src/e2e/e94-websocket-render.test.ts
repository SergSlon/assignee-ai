/**
 * Epic 94 N8 (C-01) — E2E CLI probe: WebSocket pattern renders all
 * 12 companion resources in the JSON envelope.
 *
 * Pre-fix: the compound-mode queue-advance helper skipped
 * `provisionable: false` resources, so the envelope only carried the
 * 3 deploy targets (IAM role + Lambda + LogGroup). Users could not
 * verify `ProtocolType: WEBSOCKET` or `RouteSelectionExpression:
 * $request.body.action` before `apply` — a silent HTTP fallback
 * would be indistinguishable at plan time.
 *
 * Post-fix: the skip is removed (PLAN mode only — APPLY still skips
 * at the provisioner). compound-plan.ts synthesises display-only
 * placeholders for each companion, and the formatter emits one
 * payload per resource. The CLI stdout interceptor aggregates them
 * into `{ ok: true, plans: [ ...12 entries ] }`.
 *
 * Probes:
 *   1. Envelope is a single parseable JSON value (`jq -e .` exits 0).
 *   2. Total resource count (`.plans | length` or `.plan + .plans`)
 *      is at least 12.
 *   3. Recursive walk finds `ProtocolType == "WEBSOCKET"` somewhere.
 *   4. Recursive walk finds `RouteSelectionExpression ==
 *      "$request.body.action"` somewhere.
 *
 * Gated by `RUN_E2E=1`. Run via:
 *   RUN_E2E=1 pnpm --filter assignee vitest run \
 *     src/e2e/e94-websocket-render.test.ts
 *
 * Requires:
 *   - `pnpm build` produced `apps/cli/dist/index.js`.
 *   - AWS credentials (via `.env`) because plan path still resolves
 *     region context. No actual provisioning occurs — `--no-apply`
 *     prevents any CCAPI calls.
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
 * field. Used to verify `ProtocolType: "WEBSOCKET"` is reachable
 * somewhere in the envelope without needing to know the exact envelope
 * shape — matches the `jq '[.. | objects | .FieldName? // empty]'`
 * acceptance probe in the story.
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

describeE2E(
  "Epic 94 N8 — WebSocket pattern renders all 12 resources (C-01)",
  () => {
    beforeAll(() => {
      loadEnv();
    });

    it("CLI dist exists (prerequisite — run `pnpm build` first)", () => {
      expect(fs.existsSync(CLI_DIST)).toBe(true);
    });

    it("plan --output json `Create a websocket-api` produces a parseable envelope with all 12 resources + ProtocolType WEBSOCKET", () => {
      const { stdout, code, stderr } = runCli([
        "plan",
        "--no-apply",
        "--output",
        "json",
        "Create a websocket-api",
      ]);

      // Non-zero exit is acceptable when --no-apply was the gate; plan
      // itself must succeed. Guard the common case.
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
      // If the LLM failed to route to the websocket pattern (network
      // hiccup, bad model response), surface the error details so the
      // probe is debuggable. Do NOT silently pass.
      expect(
        env.ok,
        `envelope must be ok:true. error: ${JSON.stringify(env.error)}`,
      ).toBe(true);

      // Accept either shape: single-resource plan has `.plan`, compound
      // has `.plans`. For websocket-api we expect the compound shape.
      const planCount =
        (env.plans?.length ?? 0) + (env.plan !== undefined ? 1 : 0);
      expect(
        planCount,
        `WebSocket compound must render all 12 resources; got ${planCount}`,
      ).toBeGreaterThanOrEqual(12);

      // Load-bearing verification: ProtocolType=WEBSOCKET must appear
      // somewhere in the envelope so operators can verify the API will
      // be a WebSocket (not an HTTP) endpoint before apply.
      const protocolTypes = collectFieldValues(parsed, "ProtocolType");
      expect(
        protocolTypes,
        `ProtocolType values found in envelope: ${JSON.stringify(protocolTypes)}`,
      ).toContain("WEBSOCKET");

      // Load-bearing verification: RouteSelectionExpression must appear
      // with the AWS canonical value so operators can confirm the
      // `$request.body.action` dispatch contract.
      const routeSelections = collectFieldValues(
        parsed,
        "RouteSelectionExpression",
      );
      expect(
        routeSelections,
        `RouteSelectionExpression values: ${JSON.stringify(routeSelections)}`,
      ).toContain("$request.body.action");

      // Exit code may be 0 (plan succeeded) — guard against regression.
      expect(code).toBe(0);
    });

    it("companion resources carry `provisionable: false` so consumers can filter deploy targets", () => {
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
      // Exactly 3 provisionable (IAM role + Lambda + LogGroup) and
      // 9 display-only companions (API + 3 Integrations + 3 Routes +
      // Stage + Permission).
      expect(provisionableCount).toBe(3);
      expect(companionCount).toBe(9);
    });
  },
);

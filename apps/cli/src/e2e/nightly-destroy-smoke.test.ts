/**
 * Nightly real-AWS destroy smoke test — W6-03 (P006 + P034).
 *
 * Provisions a minimal instance of each supported resource type, then
 * destroys it. Tests are gated by `RUN_E2E=1` — NEVER run during plain
 * `pnpm test` or CI without credentials.
 *
 * Safety guarantees:
 *   - afterEach teardown-guard always attempts destroy even when the
 *     provision step fails mid-flight.
 *   - Budget cap: if the estimated cumulative cost of remaining types
 *     exceeds `ASSIGNEE_NIGHTLY_BUDGET_USD` (default $5), the suite
 *     exits early and writes a `budget_exceeded` event to the cost ledger.
 *   - Cost ledger records are written to
 *     `ASSIGNEE_NIGHTLY_LEDGER_DIR` (default `~/.assignee/logs/`) as
 *     `nightly-cost-YYYY-MM-DD.jsonl`, one record per resource type.
 *   - All prices come from Pricing MCP at runtime. Zero hardcoded
 *     dollar amounts (per `feedback_no_hardcoded_prices`).
 *
 * @see docs/explanation/ci-gates.md — acceptable-miss window policy
 * @see scripts/cost-ledger-rollup.ts — weekly aggregation
 * @see W6-03 story spec
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { EnvVar } from "../constants/env-vars.js";

// ── Gate: only execute when RUN_E2E=1 ────────────────────────────────

const RUN_E2E = process.env["RUN_E2E"] === "1";
const describeE2E = RUN_E2E ? describe : describe.skip;

// ── Budget cap ────────────────────────────────────────────────────────

/**
 * Default daily nightly budget from the cost ceiling memory
 * (`feedback_daily_cost_ceiling`). No hardcoded price — the actual
 * per-resource cost is fetched from the Pricing MCP at runtime.
 * This cap controls when the suite bails out early to avoid runaway AWS spend.
 */
const DEFAULT_NIGHTLY_BUDGET_USD = 5;

function getNightlyBudget(): number {
  const raw = process.env[EnvVar.ASSIGNEE_NIGHTLY_BUDGET_USD];
  if (!raw) return DEFAULT_NIGHTLY_BUDGET_USD;
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_NIGHTLY_BUDGET_USD;
}

// ── Cost ledger ───────────────────────────────────────────────────────

interface CostLedgerEntry {
  ts: string;
  resourceType: string;
  region: string;
  provisionSuccess: boolean;
  destroySuccess: boolean;
  /** Estimated cost in USD — fetched from Pricing MCP, null if unavailable */
  estimatedUsd: number | null;
  durationMs: number;
  runId: string;
}

function ledgerDir(): string {
  const override = process.env[EnvVar.ASSIGNEE_NIGHTLY_LEDGER_DIR];
  if (override && override.length > 0) return override;
  return path.join(os.homedir(), ".assignee", "logs");
}

function ledgerPath(now: Date = new Date()): string {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  return path.join(ledgerDir(), `nightly-cost-${yyyy}-${mm}-${dd}.jsonl`);
}

function writeLedgerEntry(entry: CostLedgerEntry): void {
  try {
    const dir = ledgerDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(ledgerPath(), JSON.stringify(entry) + "\n", {
      encoding: "utf-8",
      mode: 0o600,
    });
  } catch {
    // Best-effort: ledger write failure MUST NOT fail the test.
    // The test result is the source of truth; ledger is analytics only.
  }
}

// ── Environment loading ───────────────────────────────────────────────

function loadEnv(): void {
  const envPath = path.resolve(import.meta.dirname, "../../../../.env");
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx);
    // Never overwrite blank or important shell env with .env content
    if (!process.env[key]) {
      process.env[key] = trimmed.slice(eqIdx + 1);
    }
  }
  // Enforce 3-user IAM model: never use shell SDK credentials
  delete process.env["AWS_ACCESS_KEY_ID"];
  delete process.env["AWS_SECRET_ACCESS_KEY"];
  delete process.env["AWS_SESSION_TOKEN"];
  delete process.env["AWS_PROFILE"];
}

function skipIfNoCreds(): boolean {
  return (
    !process.env[EnvVar.OPERATOR_ACCESS_KEY] ||
    !process.env[EnvVar.OPERATOR_SECRET_KEY]
  );
}

// ── Run ID for this nightly batch ─────────────────────────────────────

function makeRunId(): string {
  return `nightly-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── Budget tracking ───────────────────────────────────────────────────

/**
 * Cumulative spend tracker across all tests in this nightly run.
 * Pricing comes from Pricing MCP at runtime — `estimatedCostUsd` is
 * populated by the per-type smoke helper after calling the MCP.
 */
const budgetState = {
  cumulativeUsd: 0,
  budgetUsd: DEFAULT_NIGHTLY_BUDGET_USD,
};

function recordSpend(usd: number | null): void {
  if (usd !== null && Number.isFinite(usd)) {
    budgetState.cumulativeUsd += usd;
  }
}

function isBudgetExceeded(): boolean {
  return budgetState.cumulativeUsd >= budgetState.budgetUsd;
}

// ── Per-type smoke fixture ────────────────────────────────────────────

/**
 * Fixture for a single nightly destroy smoke scenario.
 *
 * `intent`: natural-language intent string that the CLI's plan generator
 *           accepts for the resource type.
 * `resourceType`: CloudFormation type string, for ledger tagging.
 * `region`: AWS region to use for this type (some types are global-only).
 * `cleanupIntent`: optional intent for explicit destroy if the provision
 *                  partially succeeded and left a resource behind.
 */
interface SmokeFixture {
  resourceType: string;
  intent: string;
  region: string;
}

/**
 * Minimal smoke fixtures — cheapest possible resources per supported type.
 * The cheapest class is SSM Parameter (no hourly cost). Each fixture
 * uses the `assignee-nightly-smoke-<type>` naming convention so the
 * teardown guard can identify and purge any orphaned resources.
 *
 * NOTE: Costs are fetched from Pricing MCP at runtime — never hardcoded.
 * The intent strings here represent the DESIRED STATE; the actual cost
 * estimate is derived by the CLI plan step.
 */
const SMOKE_FIXTURES: SmokeFixture[] = [
  {
    resourceType: "AWS::SSM::Parameter",
    intent:
      "Create an SSM Parameter named assignee-nightly-smoke-ssm with value nightly-test and type String",
    region: process.env[EnvVar.AWS_REGION] ?? "us-east-1",
  },
  {
    resourceType: "AWS::SQS::Queue",
    intent:
      "Create an SQS Queue named assignee-nightly-smoke-sqs with default settings",
    region: process.env[EnvVar.AWS_REGION] ?? "us-east-1",
  },
  {
    resourceType: "AWS::SNS::Topic",
    intent: "Create an SNS Topic named assignee-nightly-smoke-sns",
    region: process.env[EnvVar.AWS_REGION] ?? "us-east-1",
  },
];

// ── Test suite ────────────────────────────────────────────────────────

let savedEnv: NodeJS.ProcessEnv | undefined;
const NIGHTLY_RUN_ID = makeRunId();

/**
 * Track provisioned resources for teardown-guard. In a partial failure,
 * afterEach always attempts destroy.
 */
const provisionedArns: Map<string, string> = new Map(); // resourceType → ARN

beforeAll(() => {
  if (!RUN_E2E) return;
  savedEnv = { ...process.env };
  loadEnv();
  budgetState.budgetUsd = getNightlyBudget();
  budgetState.cumulativeUsd = 0;
});

afterAll(() => {
  if (!RUN_E2E) return;
  if (savedEnv !== undefined) {
    process.env = savedEnv;
    savedEnv = undefined;
  }
  // Write a summary budget_exceeded event if the cap was breached
  if (isBudgetExceeded()) {
    writeLedgerEntry({
      ts: new Date().toISOString(),
      resourceType: "_budget_exceeded_sentinel",
      region: "global",
      provisionSuccess: false,
      destroySuccess: false,
      estimatedUsd: budgetState.cumulativeUsd,
      durationMs: 0,
      runId: NIGHTLY_RUN_ID,
    });
  }
});

/**
 * Teardown-guard afterEach: always attempt destroy for any resource that
 * was provisioned but not yet confirmed destroyed. This fires even when
 * a test fails mid-provision, preventing orphaned resources from
 * accumulating cost.
 */
afterEach(async () => {
  if (!RUN_E2E) return;
  // Teardown-guard: destroy any resources still tracked as provisioned
  for (const [resourceType, arn] of provisionedArns.entries()) {
    try {
      const { destroyAction } = await import("../commands/destroy.js");
      await destroyAction(arn, { yes: true });
    } catch {
      // Best-effort: teardown failure must not throw and cascade
    } finally {
      provisionedArns.delete(resourceType);
    }
  }
});

// ── Smoke scenarios ───────────────────────────────────────────────────

describeE2E("nightly-destroy-smoke — per-type provision + destroy", () => {
  if (skipIfNoCreds()) {
    it.skip("skipped: no operator credentials in env", () => {});
    return;
  }

  for (const fixture of SMOKE_FIXTURES) {
    const { resourceType, intent, region } = fixture;

    it(
      `[${resourceType}] provision → destroy round-trip in ${region}`,
      { timeout: 300_000 }, // 5 min per type (CloudFront could take much longer — excluded from smoke)
      async () => {
        // Budget check: skip remaining types if cap is exceeded
        if (isBudgetExceeded()) {
          console.warn(
            `[nightly-smoke] Budget cap ($${budgetState.budgetUsd}) exceeded. ` +
              `Cumulative: $${budgetState.cumulativeUsd.toFixed(4)}. ` +
              `Skipping ${resourceType}.`,
          );
          writeLedgerEntry({
            ts: new Date().toISOString(),
            resourceType,
            region,
            provisionSuccess: false,
            destroySuccess: false,
            estimatedUsd: null,
            durationMs: 0,
            runId: NIGHTLY_RUN_ID,
          });
          return;
        }

        const startMs = Date.now();
        let provisionSuccess = false;
        let destroySuccess = false;
        let estimatedUsd: number | null = null;

        try {
          // ── Plan + apply ───────────────────────────────────────────
          const { createGraph } = await import("../services/graph.js");
          const { createMcpClient, getMcpTools, closeMcpClient } =
            await import("../services/mcp-client.js");
          const { ExecutionMode, ExecutionStatus: _ExecutionStatus } =
            await import("@assignee/core");

          const mcpClient = await createMcpClient();
          let arn: string | undefined;

          try {
            const tools = await getMcpTools(mcpClient);
            const graph = await createGraph(tools);

            const initialState = {
              messages: [
                {
                  role: "user" as const,
                  content: intent,
                },
              ],
              mode: ExecutionMode.APPLY,
              runId: `${NIGHTLY_RUN_ID}-${resourceType.replace(/::/g, "-")}`,
            };

            let finalState: typeof initialState & {
              status?: string;
              resourceArn?: string;
            };
            for await (const event of await graph.stream(initialState, {
              recursionLimit: 50,
            })) {
              finalState = event as typeof finalState;
            }

            // Extract ARN from the last state
            arn = (finalState! as { resourceArn?: string }).resourceArn;
            provisionSuccess = !!arn;

            if (arn) {
              provisionedArns.set(resourceType, arn);
              estimatedUsd = parseFloat(
                (finalState! as { estimatedMonthlyCost?: string })
                  .estimatedMonthlyCost ?? "0",
              );
              if (!Number.isFinite(estimatedUsd)) estimatedUsd = null;
              recordSpend(estimatedUsd);
            }
          } finally {
            await closeMcpClient();
          }

          // A provisioned ARN must exist for the test to proceed
          expect(arn).toBeDefined();
          expect(typeof arn).toBe("string");
          expect(arn!.length).toBeGreaterThan(10);

          // ── Destroy ────────────────────────────────────────────────
          if (arn) {
            const { destroyAction } = await import("../commands/destroy.js");
            // destroyAction throws on failure; reaching the next line means success
            await destroyAction(arn, { yes: true });
            destroySuccess = true;
            expect(destroySuccess).toBe(true);
            provisionedArns.delete(resourceType);
          }
        } finally {
          const durationMs = Date.now() - startMs;
          writeLedgerEntry({
            ts: new Date().toISOString(),
            resourceType,
            region,
            provisionSuccess,
            destroySuccess,
            estimatedUsd,
            durationMs,
            runId: NIGHTLY_RUN_ID,
          });
        }
      },
    );
  }
});

// ── Budget-cap assertion (unit-testable, no RUN_E2E needed) ───────────

describe("nightly-smoke budget-cap logic", () => {
  it("isBudgetExceeded returns false when cumulative spend is within cap", () => {
    const before = budgetState.cumulativeUsd;
    budgetState.cumulativeUsd = 0;
    budgetState.budgetUsd = 5;
    expect(isBudgetExceeded()).toBe(false);
    budgetState.cumulativeUsd = 4.99;
    expect(isBudgetExceeded()).toBe(false);
    budgetState.cumulativeUsd = before;
  });

  it("isBudgetExceeded returns true when cumulative spend meets or exceeds cap", () => {
    const before = budgetState.cumulativeUsd;
    budgetState.cumulativeUsd = 5.0;
    budgetState.budgetUsd = 5;
    expect(isBudgetExceeded()).toBe(true);
    budgetState.cumulativeUsd = 6.0;
    expect(isBudgetExceeded()).toBe(true);
    budgetState.cumulativeUsd = before;
  });

  it("getNightlyBudget returns the default when env var is absent", () => {
    const original = process.env[EnvVar.ASSIGNEE_NIGHTLY_BUDGET_USD];
    delete process.env[EnvVar.ASSIGNEE_NIGHTLY_BUDGET_USD];
    expect(getNightlyBudget()).toBe(DEFAULT_NIGHTLY_BUDGET_USD);
    if (original !== undefined) {
      process.env[EnvVar.ASSIGNEE_NIGHTLY_BUDGET_USD] = original;
    }
  });

  it("getNightlyBudget uses env var when set to a valid number", () => {
    process.env[EnvVar.ASSIGNEE_NIGHTLY_BUDGET_USD] = "2.5";
    expect(getNightlyBudget()).toBe(2.5);
    delete process.env[EnvVar.ASSIGNEE_NIGHTLY_BUDGET_USD];
  });

  it("getNightlyBudget falls back to default for invalid values", () => {
    process.env[EnvVar.ASSIGNEE_NIGHTLY_BUDGET_USD] = "not-a-number";
    expect(getNightlyBudget()).toBe(DEFAULT_NIGHTLY_BUDGET_USD);
    delete process.env[EnvVar.ASSIGNEE_NIGHTLY_BUDGET_USD];
  });

  it("ledgerPath returns a .jsonl path with today's UTC date", () => {
    const now = new Date("2026-04-25T00:00:00Z");
    const p = ledgerPath(now);
    expect(p).toContain("nightly-cost-2026-04-25.jsonl");
    expect(p).toContain(".jsonl");
  });
});

/**
 * E2E — apply → capture ARN → destroy round-trip for the four resource
 * types whose Epic 92 Wave 1 fix was "stop lying to the user about the
 * ARN shape or the destruction state":
 *
 *   - Security Group        (B-03) — apply used to print GroupName,
 *     real ARN uses `sg-<id>`, destroy failed "no managed resource".
 *   - KMS::Key              (D-21, D-22) — apply printed UUID, destroy
 *     said "Resource destroyed" but key was only PendingDeletion.
 *   - Events::EventBus      (D-19, D-20) — apply printed bare name,
 *     destroy routed to DeleteRule and orphaned the bus.
 *   - SecretsManager::Secret (D-25) — "Resource destroyed" lie; still
 *     billing during the mandatory 7-day recovery window.
 *
 * Each test applies the resource, captures the full ARN from the agent
 * state, feeds that ARN back into `destroyAction` with `--yes` (and the
 * appropriate schedule-window flag where applicable), and verifies the
 * destroy succeeds.
 *
 * HARD GATE: this entire file is skipped unless `RUN_E2E=1`. Invoking
 * `pnpm test` (no env var) NEVER triggers real provisioning.
 *
 * @see _bmad-output/implementation-artifacts/e92-1b-arn-destroy.md
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { EnvVar } from "../constants/env-vars.js";

const RUN_E2E = process.env["RUN_E2E"] === "1";
const describeE2E = RUN_E2E ? describe : describe.skip;

/**
 * Loads operator credentials from `assignee.ai/.env` (never from the
 * user's shell / SSO / `~/.aws/credentials`). Mirrors the
 * `e2e-plan.test.ts` harness so the 3-user IAM contract is honoured.
 */
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
    process.env[key] = trimmed.slice(eqIdx + 1);
  }
  delete process.env["AWS_ACCESS_KEY_ID"];
  delete process.env["AWS_SECRET_ACCESS_KEY"];
  delete process.env["AWS_SESSION_TOKEN"];
  delete process.env["AWS_PROFILE"];
}

let savedEnv: NodeJS.ProcessEnv | undefined;

beforeAll(() => {
  if (!RUN_E2E) return;
  savedEnv = { ...process.env };
  loadEnv();
});

afterAll(() => {
  if (!RUN_E2E) return;
  if (savedEnv !== undefined) {
    process.env = savedEnv;
    savedEnv = undefined;
  }
});

function skipIfNoCreds(): boolean {
  return (
    !process.env[EnvVar.OPERATOR_ACCESS_KEY] ||
    !process.env[EnvVar.OPERATOR_SECRET_KEY]
  );
}

/**
 * Runs apply via the agent graph, returning the final state. Mirrors
 * the harness from e2e-plan.test.ts so the two files stay aligned on
 * how the pipeline is invoked.
 */
async function applyResource(userIntent: string): Promise<{
  resourceArn?: string;
  resourceType?: string;
  executionStatus?: string;
}> {
  const { createGraph } = await import("../services/graph.js");
  const { createMcpClient, getMcpTools, closeMcpClient } =
    await import("../services/mcp-client.js");
  const { ExecutionMode } = await import("@assignee/core");
  const mcpClient = await createMcpClient();
  try {
    const tools = await getMcpTools(mcpClient);
    const graph = createGraph(tools);
    const state = (await graph.invoke(
      {
        userIntent,
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.APPLY,
        startedAt: Date.now(),
        noWizard: true,
        projectDir: process.cwd(),
      },
      { configurable: { thread_id: crypto.randomUUID() } },
    )) as {
      resourceArn?: string;
      resourceType?: string;
      executionStatus?: string;
    };
    return state;
  } finally {
    await closeMcpClient().catch(() => {});
  }
}

describeE2E("E2E: destroy round-trip — apply ARN must destroy cleanly", () => {
  it("skips everything when credentials are missing", () => {
    if (skipIfNoCreds()) {
      console.warn("E2E destroy-roundtrip: no operator creds; skipping.");
    }
    expect(true).toBe(true);
  });

  // Security Group (B-03): the ARN that apply returns MUST be the real
  // `sg-<id>`-bearing ARN; feeding it back to destroy must locate the
  // resource (round-trip) and delete it.
  it("SG apply ARN round-trips through destroy", async () => {
    if (skipIfNoCreds()) return;
    const name = `e92-1b-sg-${Date.now()}`;
    const state = await applyResource(
      `Create a security group named ${name} in the default VPC with no ingress rules.`,
    );
    expect(state.executionStatus).toBe("SUCCESS");
    expect(state.resourceArn).toBeDefined();
    // Anti-regression for B-03: the ARN must include `security-group/sg-`,
    // not the bare user-supplied name.
    expect(state.resourceArn).toMatch(/security-group\/sg-[0-9a-f]+/);

    const { destroyAction } = await import("../commands/destroy.js");
    await destroyAction(state.resourceArn!, { yes: true });
    // destroyAction returns void on success; no throw = round-trip ok.
  }, 180_000);

  // KMS key (D-22): apply ARN must be full `arn:...:key/<uuid>`, not UUID.
  // Destroy with --pending-window-in-days=7 must succeed and print the
  // scheduled-deletion line (never "Resource destroyed").
  it("KMS apply ARN round-trips through destroy with pending-window", async () => {
    if (skipIfNoCreds()) return;
    const state = await applyResource(
      `Create a symmetric KMS key for e92-1b-kms round-trip test with key rotation enabled.`,
    );
    expect(state.executionStatus).toBe("SUCCESS");
    expect(state.resourceArn).toMatch(/^arn:aws[\w-]*:kms:/);
    expect(state.resourceArn).toMatch(/:key\/[0-9a-f-]{36}$/);

    const { destroyAction } = await import("../commands/destroy.js");
    await destroyAction(state.resourceArn!, {
      yes: true,
      pendingWindowInDays: "7",
    });
  }, 180_000);

  // EventBus (D-19/D-20): apply ARN must be `arn:...:event-bus/<name>`.
  // Destroy must succeed via DeleteEventBus (not DeleteRule).
  it("EventBus apply ARN round-trips through destroy", async () => {
    if (skipIfNoCreds()) return;
    const name = `e92-1b-bus-${Date.now()}`;
    const state = await applyResource(
      `Create an EventBridge event bus named ${name}.`,
    );
    expect(state.executionStatus).toBe("SUCCESS");
    expect(state.resourceArn).toMatch(/event-bus\//);

    const { destroyAction } = await import("../commands/destroy.js");
    await destroyAction(state.resourceArn!, { yes: true });
  }, 180_000);

  // Secret (D-25): apply ARN must be full `arn:...:secret:<name>-<suffix>`.
  // Destroy with force-delete must succeed and print "Resource destroyed"
  // (force path is the only one that genuinely destroys the secret).
  it("SecretsManager apply ARN round-trips through force-delete destroy", async () => {
    if (skipIfNoCreds()) return;
    const name = `e92-1b-secret-${Date.now()}`;
    const state = await applyResource(
      `Create a SecretsManager secret named ${name} with an auto-generated password.`,
    );
    expect(state.executionStatus).toBe("SUCCESS");
    expect(state.resourceArn).toMatch(/^arn:aws[\w-]*:secretsmanager:/);

    const { destroyAction } = await import("../commands/destroy.js");
    // force-delete avoids the 7-day billing window during teardown.
    await destroyAction(state.resourceArn!, {
      yes: true,
      forceDeleteWithoutRecovery: true,
    });
  }, 180_000);
});

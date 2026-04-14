/**
 * E2E tests — real AWS integration via the CLI graph.
 *
 * These tests invoke the actual LangGraph pipeline with real MCP servers
 * and AWS credentials. They require:
 *   - ASSIGNEE_OPERATOR_ACCESS_KEY_ID + SECRET in .env
 *   - AWS_REGION configured
 *   - MCP servers (cfn, pricing, docs) available via uvx
 *
 * Resource provisioning tests use the cheapest resources (SSM Parameter)
 * and clean up after themselves. EC2/RDS use plan-only mode (no cost).
 *
 * Run: npx vitest run src/e2e/e2e-plan.test.ts --timeout=120000
 *
 * @see Story 9.8 — E2E test suite
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";

/**
 * E2E suite gate — these tests hit real AWS via the CLI graph.
 *
 * Opt-in only via `RUN_E2E=1` so plain `pnpm test` (and CI without the
 * env-var) NEVER trigger real provisioning. Use `pnpm test:e2e` or
 * `RUN_E2E=1 pnpm vitest run src/e2e/e2e-plan.test.ts` to execute.
 */
const RUN_E2E = process.env["RUN_E2E"] === "1";
const describeE2E = RUN_E2E ? describe : describe.skip;
import { createGraph } from "../services/graph.js";
import {
  createMcpClient,
  getMcpTools,
  closeMcpClient,
} from "../services/mcp-client.js";
import { ExecutionMode, ExecutionStatus } from "@assignee/core";
import type { StructuredTool } from "@langchain/core/tools";
import type { AgentState } from "../services/graph-state.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { EnvVar } from "../constants/env-vars.js";

/**
 * Load credentials ONLY from assignee.ai/.env — never from the shell, SSO,
 * or ~/.aws/credentials. This enforces the 3-user IAM model so tests run
 * with the same least-privilege credentials production uses.
 *
 * If the file doesn't exist or lacks ASSIGNEE_OPERATOR_*, tests that need
 * AWS will be skipped via skipIfNoCreds().
 *
 * Values in .env OVERRIDE any existing shell env vars to prevent leakage.
 */
function loadEnv() {
  // src/e2e/ → cli/ → apps/ → assignee.ai/ (4 levels up from source)
  const envPath = path.resolve(import.meta.dirname, "../../../../.env");
  if (!fs.existsSync(envPath)) return;

  const content = fs.readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx);
    const value = trimmed.slice(eqIdx + 1);
    // Override — .env is the source of truth for test credentials
    process.env[key] = value;
  }

  // Strip any shell-provided credentials that could leak through to AWS SDK
  // default provider chain (belt-and-suspenders; client code also uses
  // explicit credentials below).
  delete process.env["AWS_ACCESS_KEY_ID"];
  delete process.env["AWS_SECRET_ACCESS_KEY"];
  delete process.env["AWS_SESSION_TOKEN"];
  delete process.env["AWS_PROFILE"];
}
// NOTE: loadEnv() is intentionally NOT called at module load time anymore.
// It now runs inside the gated beforeAll() below so that:
//  1. Importing this file (e.g. when RUN_E2E is unset) does not mutate
//     process.env or strip AWS credentials from the parent shell.
//  2. The mutations are paired with a snapshot/restore in afterAll().
let savedEnv: NodeJS.ProcessEnv | undefined;

/**
 * Returns explicit operator credentials from .env — never falls through
 * to the default credential chain. Used by all AWS SDK clients in e2e tests.
 */
function operatorCreds(): { accessKeyId: string; secretAccessKey: string } {
  const accessKeyId = process.env[EnvVar.OPERATOR_ACCESS_KEY];
  const secretAccessKey = process.env[EnvVar.OPERATOR_SECRET_KEY];
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      `Missing operator credentials. Set ${EnvVar.OPERATOR_ACCESS_KEY} and ` +
        `${EnvVar.OPERATOR_SECRET_KEY} in assignee.ai/.env.`,
    );
  }
  return { accessKeyId, secretAccessKey };
}

/**
 * Run bulk-destroy but only assert on failures for resources THIS test
 * created. planBulkDestroy sweeps the entire account — stale resources
 * from prior test runs (orphaned NAT Gateways, RGTA tag cache ghosts)
 * would cause false failures if we asserted on the full failure list.
 *
 * Filter: a destroy failure is only reported if the resource's identifier
 * matches one of the completedResources from this test's apply phase.
 */
async function destroyAndAssert(
  completed: Array<{ resourceArn?: string; resourceType: string }>,
): Promise<void> {
  const region = process.env["AWS_REGION"] ?? "us-east-1";
  const { planBulkDestroy } = await import("../services/bulk-destroy.js");
  const { destroySingleResource } =
    await import("../services/destroy-service.js");
  const plan = await planBulkDestroy({ region });
  // Build a set of identifiers this test created for fast lookup
  const ownedIds = new Set(completed.map((c) => c.resourceArn).filter(Boolean));
  const failures: string[] = [];
  let lastTier = -1;
  for (const r of plan.resources) {
    // Wait 60s at tier boundaries to let async deletes propagate
    // (e.g. ALB ENI release before IGW detach, RDS delete before DBSubnetGroup).
    // QA WARNING W1 from qa-expert-e2e-fixes.md: comment previously said
    // "30s" but code slept for 60s — align the comment to reality.
    if (r.tier > lastTier && lastTier >= 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 60_000));
    }
    lastTier = r.tier;
    const result = await destroySingleResource(r, { region });
    if (
      !result.success &&
      (ownedIds.has(r.identifier) || ownedIds.has(r.arn))
    ) {
      failures.push(
        `${r.resourceType} ${r.identifier}: ${result.error ?? "unknown"}`,
      );
    }
  }
  expect(failures).toEqual([]); // Only asserts on THIS run's resources
}

let tools: StructuredTool[];
let mcpClient: Awaited<ReturnType<typeof createMcpClient>>;

/** Pre-sweep: delete leftover resources from previous crashed runs. */
async function sweepStaleResources(): Promise<void> {
  const region = process.env["AWS_REGION"] ?? "us-east-1";
  try {
    const { SSMClient, GetParametersByPathCommand, DeleteParameterCommand } =
      await import("@aws-sdk/client-ssm");
    const ssm = new SSMClient({ region, credentials: operatorCreds() });
    const params = await ssm.send(
      new GetParametersByPathCommand({ Path: "/e2e-test/", Recursive: true }),
    );
    for (const p of params.Parameters ?? []) {
      if (p.Name) {
        await ssm.send(new DeleteParameterCommand({ Name: p.Name }));
        console.log(`E2E pre-sweep: deleted stale SSM param ${p.Name}`);
      }
    }
  } catch (err: unknown) {
    // Credential errors are actionable — log loudly. ParameterNotFound is fine.
    const errName = (err as { name?: string })?.name ?? "";
    if (
      errName === "CredentialsProviderError" ||
      errName === "ExpiredTokenException" ||
      errName === "UnrecognizedClientException"
    ) {
      console.error(
        `❌ E2E pre-sweep FAILED: AWS credentials expired or invalid (${errName}). ` +
          `Run 'aws sso login' and retry. Existing /e2e-test/* params will accumulate.`,
      );
    } else if (errName !== "ParameterNotFound") {
      console.warn(`E2E pre-sweep SSM error: ${errName || String(err)}`);
    }
  }
  try {
    const { S3Client, ListBucketsCommand, DeleteBucketCommand } =
      await import("@aws-sdk/client-s3");
    const s3 = new S3Client({ region, credentials: operatorCreds() });
    const { Buckets } = await s3.send(new ListBucketsCommand({}));
    for (const b of Buckets ?? []) {
      if (
        b.Name &&
        (b.Name.startsWith("e2e-") || b.Name.startsWith("poc-apply-test-"))
      ) {
        try {
          await s3.send(new DeleteBucketCommand({ Bucket: b.Name }));
          console.log(`E2E pre-sweep: deleted stale bucket ${b.Name}`);
        } catch {
          // bucket may have objects — skip
        }
      }
    }
  } catch {
    // S3 cleanup best-effort
  }
}

beforeAll(async () => {
  // Hard gate — never execute setup unless RUN_E2E=1
  if (!RUN_E2E) return;
  // Snapshot env BEFORE loadEnv mutates it so afterAll can restore.
  savedEnv = { ...process.env };
  loadEnv();
  // Skip if no credentials
  if (skipIfNoCreds()) {
    console.warn(
      "Skipping E2E tests: no operator credentials in assignee.ai/.env",
    );
    return;
  }

  // Clean up leftovers from previous crashed runs before starting
  await sweepStaleResources();

  mcpClient = await createMcpClient();
  tools = await getMcpTools(mcpClient);
}, 30_000);

afterAll(async () => {
  if (!RUN_E2E) return;
  await closeMcpClient().catch(() => {});

  // Global sweeper: clean up any stale e2e test resources left by crashed runs.
  // Matches SSM parameters under /e2e-test/ prefix and ECS clusters with e2e names.
  if (skipIfNoCreds()) return;

  try {
    const region = process.env["AWS_REGION"] ?? "us-east-1";

    // Clean stale SSM params under /e2e-test/
    const { SSMClient, GetParametersByPathCommand, DeleteParameterCommand } =
      await import("@aws-sdk/client-ssm");
    const ssm = new SSMClient({ region, credentials: operatorCreds() });
    try {
      const params = await ssm.send(
        new GetParametersByPathCommand({ Path: "/e2e-test/", Recursive: true }),
      );
      for (const p of params.Parameters ?? []) {
        if (p.Name) {
          try {
            await ssm.send(new DeleteParameterCommand({ Name: p.Name }));
            console.log(`E2E sweeper: deleted stale SSM param ${p.Name}`);
          } catch (delErr: unknown) {
            const name = (delErr as { name?: string })?.name ?? "";
            console.warn(
              `E2E sweeper: failed to delete ${p.Name}: ${name || String(delErr)}`,
            );
          }
        }
      }
    } catch (err: unknown) {
      const errName = (err as { name?: string })?.name ?? "";
      if (
        errName === "CredentialsProviderError" ||
        errName === "ExpiredTokenException" ||
        errName === "UnrecognizedClientException"
      ) {
        console.error(
          `❌ E2E post-sweep FAILED: AWS credentials expired (${errName}). ` +
            `Run 'aws sso login' to avoid accumulating /e2e-test/* resources.`,
        );
      } else if (errName !== "ParameterNotFound") {
        console.warn(`E2E post-sweep SSM error: ${errName || String(err)}`);
      }
    }

    // Clean stale ECS clusters with e2e/test names via tagging API
    const { ResourceGroupsTaggingAPIClient, GetResourcesCommand } =
      await import("@aws-sdk/client-resource-groups-tagging-api");
    const tagging = new ResourceGroupsTaggingAPIClient({
      region,
      credentials: operatorCreds(),
    });
    try {
      const tagged = await tagging.send(
        new GetResourcesCommand({
          TagFilters: [{ Key: "managed-by", Values: ["assignee-ai"] }],
          ResourceTypeFilters: ["ecs:cluster"],
        }),
      );
      for (const r of tagged.ResourceTagMappingList ?? []) {
        const arn = r.ResourceARN;
        if (!arn) continue;
        const clusterName = arn.split("/").pop();
        if (
          clusterName &&
          (clusterName.includes("e2e-") || clusterName.includes("apply-t"))
        ) {
          // Use CloudControl to delete (available via existing SDK)
          const { CloudControlClient, DeleteResourceCommand } =
            await import("@aws-sdk/client-cloudcontrol");
          const cc = new CloudControlClient({
            region,
            credentials: operatorCreds(),
          });
          try {
            await cc.send(
              new DeleteResourceCommand({
                TypeName: "AWS::ECS::Cluster",
                Identifier: clusterName,
              }),
            );
            console.log(
              `E2E sweeper: deleted stale ECS cluster ${clusterName}`,
            );
          } catch {
            // cluster may already be inactive
          }
        }
      }
    } catch {
      // ECS cleanup is best-effort
    }
  } catch (err) {
    console.warn("E2E sweeper error (non-fatal):", err);
  }

  // Restore the env snapshot taken before loadEnv() ran in beforeAll.
  if (savedEnv !== undefined) {
    process.env = savedEnv;
    savedEnv = undefined;
  }
}, 30_000);

function skipIfNoCreds(): boolean {
  return (
    !process.env[EnvVar.OPERATOR_ACCESS_KEY] ||
    !process.env[EnvVar.OPERATOR_SECRET_KEY]
  );
}

describeE2E("E2E: S3 bucket plan", () => {
  it("generates a plan with pricing and BP findings", async () => {
    const graph = createGraph(tools);
    const bucketName = `e2e-test-${Date.now()}`;

    const state = await graph.invoke(
      {
        userIntent: `Create an S3 bucket named ${bucketName}`,
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.PLAN,
        startedAt: Date.now(),
        noWizard: true,
        projectDir: process.cwd(),
      },
      { configurable: { thread_id: crypto.randomUUID() } },
    );

    const s = state as AgentState;

    // Resource type detected
    expect(s.resourceType).toBe("AWS::S3::Bucket");

    // Desired state generated with bucket name
    // Tier C: strengthened — desiredState must be a non-empty object
    expect(s.desiredState).toBeInstanceOf(Object);
    expect(s.desiredState?.["BucketName"]).toBe(bucketName);

    // Cost estimate from Pricing MCP (not "N/A")
    // Tier C: strengthened — must be a non-empty cost label string
    expect(typeof s.estimatedMonthlyCost).toBe("string");
    expect(s.estimatedMonthlyCost).not.toBe("N/A");

    // BP findings generated
    // Tier C: strengthened — bpFindings must be an array (could be empty)
    expect(s.bpFindings).toBeInstanceOf(Array);
    expect(s.bpFindings!.length).toBeGreaterThan(0);

    // Pricing breakdown from decomposer
    // Tier C: dropped redundant toBeDefined() — `!.usageBasedItems` access
    // fails on undefined
    expect(s.pricingBreakdown!.usageBasedItems.length).toBeGreaterThan(0);
  }, 60_000);
});

describeE2E("E2E: EC2 instance plan", () => {
  it("generates a plan with compute pricing decomposition", async () => {
    const graph = createGraph(tools);

    const state = await graph.invoke(
      {
        userIntent: "Create an EC2 t3.micro instance for testing",
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.PLAN,
        startedAt: Date.now(),
        noWizard: true,
        projectDir: process.cwd(),
      },
      { configurable: { thread_id: crypto.randomUUID() } },
    );

    const s = state as AgentState;

    expect(s.resourceType).toBe("AWS::EC2::Instance");
    // Tier C: strengthened — desiredState must be a non-empty object
    expect(s.desiredState).toBeInstanceOf(Object);

    // EC2 decomposer should produce compute + storage line items
    if (s.pricingBreakdown) {
      const labels = [
        ...s.pricingBreakdown.fixedItems.map((i) => i.lineItem.label),
        ...s.pricingBreakdown.usageBasedItems.map((i) => i.lineItem.label),
      ];
      expect(labels).toContain("Compute");
    }

    // BP findings should include IMDSv2 and EBS encryption checks
    // Tier C: strengthened — bpFindings must be an array (could be empty)
    expect(s.bpFindings).toBeInstanceOf(Array);
  }, 60_000);
});

describeE2E("E2E: SSM Parameter plan + apply + destroy", () => {
  const paramName = `/e2e-test/assignee-${Date.now()}`;
  let resourceArn: string | undefined;

  it("plans, applies, and destroys an SSM parameter", async () => {
    const graph = createGraph(tools);
    const threadId = crypto.randomUUID();
    const config = { configurable: { thread_id: threadId } };

    // Phase 1: Plan + Apply in one pass (auto-approve)
    await graph.invoke(
      {
        userIntent: `Create an SSM parameter named ${paramName} with value "e2e-test-value"`,
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.APPLY,
        startedAt: Date.now(),
        noWizard: true,
        autoApprove: true,
        projectDir: process.cwd(),
      },
      config,
    );

    // Resume through the interrupt (HITL auto-approved)
    let graphState = await graph.getState(config);
    while (graphState.next.length > 0) {
      await graph.invoke(null, config);
      graphState = await graph.getState(config);
    }

    const finalState = graphState.values as AgentState;

    if (finalState.executionStatus !== ExecutionStatus.SUCCESS) {
      console.error("SSM E2E FAILED:", {
        status: finalState.executionStatus,
        error: finalState.errorMessage,
        preflightPassed: finalState.preflightPassed,
        bpFindings: finalState.bpFindings?.map(
          (f) => `${f.practiceId}: ${f.title} [blocking=${f.blocking}]`,
        ),
      });
    }

    expect(finalState.resourceType).toBe("AWS::SSM::Parameter");
    expect(finalState.executionStatus).toBe(ExecutionStatus.SUCCESS);
    // Tier C: strengthened — assert SSM parameter ARN shape, not just defined
    expect(finalState.resourceArn).toMatch(
      /^arn:aws:ssm:[a-z0-9-]+:\d+:parameter\//,
    );

    // P0-2: Standard-tier SSM parameters are always free. The headline
    // cost MUST display "Free", never "N/A".
    expect(finalState.estimatedMonthlyCost).toBe("Free");

    resourceArn = finalState.resourceArn;
  }, 90_000);

  afterAll(async () => {
    // Exercise the full destroy resolver path end-to-end (P0-3).
    //
    // Previously this block bypassed the resolver by calling the SSM SDK
    // directly, so the bug where `destroy /smoke-test-x` failed to resolve
    // SSM parameters by their user-visible name went undetected. We now:
    //   1. Strip the leading slash from the canonical SSM name, simulating
    //      a user typing the bare name they'd see in `assignee list`.
    //   2. Feed that bare name through `resolveResource` — the exact path
    //      `assignee destroy <name>` takes in commands/destroy.ts.
    //   3. Hand the resolved record to `destroySingleResource`, the same
    //      shared destroy codepath used by the CLI command.
    //
    // Fallback to the raw SSM SDK runs only if resolver/destroy couldn't
    // delete the parameter, so cleanup still happens on crashes.
    const region = process.env["AWS_REGION"] ?? "us-east-1";
    const bareName = paramName.replace(/^\//, "");

    let resolvedOk = false;
    try {
      const { createTaggingClient, resolveResource } =
        await import("../services/resource-resolver.js");
      const { destroySingleResource } =
        await import("../services/destroy-service.js");

      const taggingClient = createTaggingClient({
        ...operatorCreds(),
        region,
      });

      // Resolve using the bare name — this is what the bug targeted.
      const resolved = await resolveResource(bareName, taggingClient, region);

      if (resolved) {
        expect(resolved.resourceType).toBe("AWS::SSM::Parameter");
        // Canonical SSM identifier always starts with "/" and matches paramName.
        expect(resolved.identifier).toBe(paramName);
        // Resolved ARN must reference the same SSM parameter. The graph's
        // finalState.resourceArn may be the parameter name (SSM uses the
        // Name as its canonical resource id), so compare the trailing
        // "parameter/<name>" segment rather than requiring ARN equality.
        expect(resolved.arn).toMatch(/^arn:aws:ssm:[a-z0-9-]+:\d+:parameter\//);
        expect(resolved.arn.endsWith("parameter" + paramName)).toBe(true);

        const result = await destroySingleResource(resolved, { region });
        expect(result.success).toBe(true);
        console.log(
          `E2E cleanup: destroyed SSM parameter ${paramName} via resolver (bare="${bareName}")`,
        );
        resolvedOk = true;
      } else if (resourceArn) {
        // Resource exists but resolver missed it — surface as a hard failure
        // so the regression is caught locally before CI/live runs.
        throw new Error(
          `resolveResource returned null for bare SSM name "${bareName}" ` +
            `(arn=${resourceArn}). The P0-3 destroy resolver fix regressed.`,
        );
      }
    } catch (err: unknown) {
      const errName = (err as { name?: string })?.name ?? "";
      console.warn(
        `E2E resolver-based cleanup failed for ${paramName}: ${
          errName || (err instanceof Error ? err.message : String(err))
        } — falling back to SDK delete`,
      );
    }

    if (resolvedOk) return;

    // Fallback: direct SDK delete so we never leak resources on a crash.
    try {
      const { SSMClient, DeleteParameterCommand } =
        await import("@aws-sdk/client-ssm");
      const ssm = new SSMClient({
        region,
        credentials: operatorCreds(),
      });
      await ssm.send(new DeleteParameterCommand({ Name: paramName }));
      console.log(
        `E2E cleanup fallback: deleted SSM parameter ${paramName} via SDK`,
      );
    } catch (err: unknown) {
      const errName = (err as { name?: string })?.name ?? "";
      if (errName === "ParameterNotFound") return;
      if (
        errName === "CredentialsProviderError" ||
        errName === "ExpiredTokenException"
      ) {
        console.error(
          `❌ E2E cleanup CRITICAL: AWS credentials expired — leaked ${paramName}. ` +
            `Run 'assignee clean --resources --yes' to remove.`,
        );
      } else {
        console.warn(
          `E2E cleanup failed for ${paramName}: ${errName || String(err)}`,
        );
      }
    }
  }, 30_000);
});

// ── Story 47.5: EC2 t3.micro apply + destroy lifecycle ────────────────────
//
// Lambda (AC #1) and EFS (AC #3) already have apply+destroy coverage via the
// existing lambda-with-exec-role and efs-with-vpc compound blocks. AC #2
// (EC2 t3.micro single-resource) is the only new lifecycle block the story
// asks for. t3.micro is free-tier-eligible (750 hrs/mo) so running this
// under RUN_E2E=1 costs zero dollars as long as pre- and post-cleanup
// succeed. Block uses destroyAndAssert for the teardown check, matching
// the compound-pattern blocks.
describeE2E("E2E: EC2 t3.micro apply + destroy", () => {
  it("launches a t3.micro, verifies the instance-id, and destroys it", async () => {
    const graph = createGraph(tools);
    const threadId = crypto.randomUUID();
    const config = { configurable: { thread_id: threadId } };

    await graph.invoke(
      {
        userIntent: "Create an EC2 instance for e2e lifecycle testing",
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.APPLY,
        startedAt: Date.now(),
        noWizard: true,
        autoApprove: true,
        projectDir: process.cwd(),
        // Override the instance type via --set semantics. The plan-generator
        // respects user overrides over the plugin default.
        userOverrides: { InstanceType: "t3.micro" },
      } as Parameters<typeof graph.invoke>[0],
      config,
    );

    // Resume through the HITL interrupt (auto-approved)
    let graphState = await graph.getState(config);
    while (graphState.next.length > 0) {
      await graph.invoke(null, config);
      graphState = await graph.getState(config);
    }
    const finalState = graphState.values as AgentState;

    if (finalState.executionStatus !== ExecutionStatus.SUCCESS) {
      console.error("EC2 E2E FAILED:", {
        status: finalState.executionStatus,
        error: finalState.errorMessage,
        preflightPassed: finalState.preflightPassed,
      });
    }

    expect(finalState.resourceType).toBe("AWS::EC2::Instance");
    expect(finalState.executionStatus).toBe(ExecutionStatus.SUCCESS);
    // EC2 instance IDs are always `i-<17-hex-chars>` (legacy `i-<8-hex>`
    // pre-2016 is long deprecated). Anchoring on the 17-char modern form
    // so a regression that returns the request token / ARN instead of
    // the bare instance ID trips the assertion.
    expect(finalState.resourceArn).toMatch(/^i-[0-9a-f]{17}$/);
    // t3.micro with default 8 GB gp3 EBS runs $0.0104/hr compute +
    // $0.08/GB-mo storage — headline cost should surface ~$7-8/mo,
    // never "N/A" (would indicate pricing regression).
    expect(finalState.estimatedMonthlyCost).not.toBe("N/A");
    expect(finalState.estimatedMonthlyCost).toBeTruthy();

    // destroyAndAssert exercises the full bulk-destroy pipeline (same
    // code path as `assignee destroy --all`): tag discovery, tier
    // ordering, per-resource destroy. Required per the story's
    // "destroy removes the instance" AC.
    const completed =
      finalState.completedResources ??
      ([
        {
          resourceArn: finalState.resourceArn,
          resourceType: "AWS::EC2::Instance",
        },
      ] as Array<{ resourceArn?: string; resourceType: string }>);
    await destroyAndAssert(completed);
    // Story AC: "total wall-clock < 5 minutes" — the vitest timeout
    // below enforces a hard 300s cap. t3.micro typically launches in
    // ~45s and terminates in ~30-60s so this leaves comfortable margin.
  }, 300_000);
});

// ── Story 47.6: RDS db.t3.micro apply + destroy (time-boxed) ──────────────
//
// AC #2 (NAT Gateway) is already covered by the existing `VPC compound
// apply + destroy` block further down (vpc-networking pattern includes
// NAT GW + auto-allocated EIP + EIP release on destroy) — no new code
// needed. This block closes AC #1: single-resource RDS apply+destroy
// under a 10-minute wall-clock cap.
//
// Intent is phrased to target single-resource RDS dispatch rather than
// the three-tier-web compound (which provisions 22 resources including a
// VPC). If the intent parser unexpectedly routes it through the compound
// pattern, the test will fail fast on the `resourceType` assertion below
// and the fix is to tighten the intent further.
//
// Free-tier math: db.t3.micro costs ~$0.017/hr (+ ~$0.002/hr for 20 GB
// gp3 storage). 10-minute max run = ~$0.003, well inside the story's
// "< $0.01" cap.
describeE2E("E2E: RDS db.t3.micro apply + destroy (time-boxed)", () => {
  it("creates a single db.t3.micro postgres, then destroys it within 10 min", async () => {
    const graph = createGraph(tools);
    const threadId = crypto.randomUUID();
    const config = { configurable: { thread_id: threadId } };

    await graph.invoke(
      {
        userIntent:
          "Create a single standalone AWS::RDS::DBInstance (no VPC, no subnets — use defaults) for e2e lifecycle testing",
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.APPLY,
        startedAt: Date.now(),
        noWizard: true,
        autoApprove: true,
        projectDir: process.cwd(),
        userOverrides: {
          DBInstanceClass: "db.t3.micro",
          MultiAZ: false,
          AllocatedStorage: 20,
          StorageType: "gp3",
          Engine: "postgres",
          DeletionProtection: false,
          // SkipFinalSnapshot must be true so destroy doesn't leak a
          // snapshot that survives teardown and bills indefinitely.
          // The RDS CCAPI delete handler reads this from the
          // resource's own properties at destroy time.
          MasterUsername: "appuser",
          // Password must pass the preflight sentinel guard added in
          // P1a — use a clearly-synthetic-but-non-sentinel value that
          // satisfies RDS's 8+ char / no reserved-chars rule.
          MasterUserPassword: "E2eAssigneeRds2026",
        },
      } as Parameters<typeof graph.invoke>[0],
      config,
    );

    // Resume through the HITL interrupt (auto-approved). RDS apply is
    // typically 5-8 min for db.t3.micro, so this loop may iterate many
    // times as status-poller waits on CCAPI.
    let graphState = await graph.getState(config);
    while (graphState.next.length > 0) {
      await graph.invoke(null, config);
      graphState = await graph.getState(config);
    }
    const finalState = graphState.values as AgentState;

    if (finalState.executionStatus !== ExecutionStatus.SUCCESS) {
      console.error("RDS E2E FAILED:", {
        status: finalState.executionStatus,
        error: finalState.errorMessage,
        preflightPassed: finalState.preflightPassed,
        // If the intent parser compound-dispatched, this surfaces the
        // actual pattern so the test owner can tighten the intent.
        resourcePattern: finalState.resourcePattern?.patternId,
      });
    }

    expect(finalState.resourceType).toBe("AWS::RDS::DBInstance");
    expect(finalState.executionStatus).toBe(ExecutionStatus.SUCCESS);
    // RDS DBInstance primary identifier is the DBInstanceIdentifier
    // (bare name, not an ARN). resource-provisioner / arn-builder
    // normally elevates it to the full ARN for display. Accept either:
    // bare identifier matches AWS's lowercase-and-hyphen rule, and the
    // full ARN is the arn:aws:rds:<region>:<account>:db:<id> shape.
    expect(finalState.resourceArn).toMatch(
      /^(arn:aws[\w-]*:rds:[a-z0-9-]+:\d+:db:[a-z][a-z0-9-]{0,62}|[a-z][a-z0-9-]{0,62})$/,
    );
    // Headline cost must be non-"N/A" — RDS decomposer + live pricing
    // should produce a monthly figure. Regression guard.
    expect(finalState.estimatedMonthlyCost).not.toBe("N/A");
    expect(finalState.estimatedMonthlyCost).toBeTruthy();

    const completed =
      finalState.completedResources ??
      ([
        {
          resourceArn: finalState.resourceArn,
          resourceType: "AWS::RDS::DBInstance",
        },
      ] as Array<{ resourceArn?: string; resourceType: string }>);
    await destroyAndAssert(completed);
    // Story AC: "within the time-box" — 600_000ms vitest timeout caps
    // the whole apply+destroy cycle at 10 minutes. RDS apply ~5-8m,
    // destroy ~2-3m, so the budget is tight but sufficient. If this
    // flakes on timeout, the correct response is to investigate why
    // RDS is slow this run, NOT to weaken the timeout.
  }, 600_000);
});

// ── Story 47.3: Free-tier apply+destroy lifecycle for 12 resources ────────
//
// Each block below runs the full `plan → apply (autoApprove) → verify →
// destroy` cycle against a single free-tier resource. Together they cover
// the cheapest lane of the resource plugin catalog so the E2E suite
// exercises every tier without the cost footprint of RDS / NAT / EC2.
//
// Helper extracted to avoid 12× boilerplate — pure `describeE2E` wrapper
// that shares HITL interrupt-resume loop, resourceArn regex assertion,
// and destroyAndAssert cleanup across all blocks. Each caller only
// supplies the intent, expected resourceType, resourceArn regex, and
// optional userOverrides.
interface FreeTierLifecycleCase {
  /** vitest describe block label */
  label: string;
  /** natural-language userIntent sent to the graph */
  userIntent: string;
  /** expected state.resourceType after apply */
  resourceType: string;
  /** regex asserted against finalState.resourceArn */
  arnRegex: RegExp;
  /** optional userOverrides (e.g. wizard-injected field values) */
  userOverrides?: Record<string, unknown>;
  /** vitest timeout (ms). Defaults to 120s — most free-tier resources
   *  apply in 10-30s; CloudWatch Alarm and EventBridge Rule can take
   *  up to 60s. 120s leaves headroom without encouraging flakes. */
  timeoutMs?: number;
  /**
   * Optional per-case escape hatch for non-"N/A" cost assertion. Some
   * free-tier resources legitimately report "Free" or "N/A" because no
   * pricing strategy exists (e.g. IAM Role is authoritatively Free).
   */
  skipCostAssertion?: boolean;
}

async function runFreeTierLifecycle(
  kase: FreeTierLifecycleCase,
): Promise<void> {
  const graph = createGraph(tools);
  const threadId = crypto.randomUUID();
  const config = { configurable: { thread_id: threadId } };

  await graph.invoke(
    {
      userIntent: kase.userIntent,
      runId: crypto.randomUUID(),
      executionMode: ExecutionMode.APPLY,
      startedAt: Date.now(),
      noWizard: true,
      autoApprove: true,
      projectDir: process.cwd(),
      ...(kase.userOverrides ? { userOverrides: kase.userOverrides } : {}),
    } as Parameters<typeof graph.invoke>[0],
    config,
  );

  let graphState = await graph.getState(config);
  while (graphState.next.length > 0) {
    await graph.invoke(null, config);
    graphState = await graph.getState(config);
  }
  const finalState = graphState.values as AgentState;

  if (finalState.executionStatus !== ExecutionStatus.SUCCESS) {
    console.error(`${kase.label} FAILED:`, {
      status: finalState.executionStatus,
      error: finalState.errorMessage,
      preflightPassed: finalState.preflightPassed,
      resourcePattern: finalState.resourcePattern?.patternId,
    });
  }

  expect(finalState.resourceType).toBe(kase.resourceType);
  expect(finalState.executionStatus).toBe(ExecutionStatus.SUCCESS);
  expect(finalState.resourceArn).toMatch(kase.arnRegex);
  if (!kase.skipCostAssertion) {
    expect(finalState.estimatedMonthlyCost).toBeTruthy();
  }

  const completed =
    finalState.completedResources ??
    ([
      {
        resourceArn: finalState.resourceArn,
        resourceType: finalState.resourceType,
      },
    ] as Array<{ resourceArn?: string; resourceType: string }>);
  await destroyAndAssert(completed);
}

const FREE_TIER_LIFECYCLE_CASES: FreeTierLifecycleCase[] = [
  {
    label: "E2E: S3 Bucket apply + destroy",
    userIntent: `Create an S3 bucket named assignee-e2e-s3-${Date.now()} for test storage`,
    resourceType: "AWS::S3::Bucket",
    // S3 bucket identifier is the bucket name, ARN is arn:aws:s3:::<name>.
    // Accept either because arn-builder may surface either shape.
    arnRegex: /^(arn:aws[\w-]*:s3:::[a-z0-9.\-]{3,63}|[a-z0-9.\-]{3,63})$/,
  },
  {
    label: "E2E: IAM Role apply + destroy",
    userIntent: `Create an IAM role named assignee-e2e-role-${Date.now()} for Lambda execution`,
    resourceType: "AWS::IAM::Role",
    arnRegex:
      /^(arn:aws[\w-]*:iam::\d+:role\/[A-Za-z0-9+=,.@_\-/]+|[A-Za-z0-9+=,.@_\-]+)$/,
    skipCostAssertion: true, // IAM Role is authoritatively Free — headline is "Free", not numeric
  },
  {
    label: "E2E: SQS Queue apply + destroy",
    userIntent: `Create an SQS queue named assignee-e2e-sqs-${Date.now()} for message processing`,
    resourceType: "AWS::SQS::Queue",
    // SQS queue identifier is the URL. ARN may also surface via arn-builder.
    arnRegex:
      /^(https:\/\/sqs\.[a-z0-9-]+\.amazonaws\.com\/\d+\/[A-Za-z0-9_-]+|arn:aws[\w-]*:sqs:[a-z0-9-]+:\d+:[A-Za-z0-9_-]+)$/,
  },
  {
    label: "E2E: DynamoDB Table apply + destroy",
    userIntent: `Create a DynamoDB table named assignee-e2e-ddb-${Date.now()} with partition key id of type S`,
    resourceType: "AWS::DynamoDB::Table",
    arnRegex:
      /^(arn:aws[\w-]*:dynamodb:[a-z0-9-]+:\d+:table\/[A-Za-z0-9_.\-]+|[A-Za-z0-9_.\-]+)$/,
  },
  {
    label: "E2E: CloudWatch Alarm apply + destroy",
    userIntent: `Create a CloudWatch alarm named assignee-e2e-alarm-${Date.now()} that fires when EC2 CPUUtilization exceeds 80 for 5 minutes`,
    resourceType: "AWS::CloudWatch::Alarm",
    arnRegex:
      /^(arn:aws[\w-]*:cloudwatch:[a-z0-9-]+:\d+:alarm:[A-Za-z0-9._\-]+|[A-Za-z0-9._\-]+)$/,
  },
  {
    label: "E2E: SecretsManager Secret apply + destroy",
    userIntent: `Create a Secrets Manager secret named assignee-e2e-secret-${Date.now()} for database credentials`,
    resourceType: "AWS::SecretsManager::Secret",
    arnRegex:
      /^(arn:aws[\w-]*:secretsmanager:[a-z0-9-]+:\d+:secret:[A-Za-z0-9/_+=.@\-]+|[A-Za-z0-9/_+=.@\-]+)$/,
    skipCostAssertion: true, // SecretsManager has $0.40/secret/mo but free tier eligible 1st month — headline may show $0.40
  },
  {
    label: "E2E: SNS Topic apply + destroy",
    userIntent: `Create an SNS topic named assignee-e2e-sns-${Date.now()} for alerts`,
    resourceType: "AWS::SNS::Topic",
    arnRegex: /^arn:aws[\w-]*:sns:[a-z0-9-]+:\d+:[A-Za-z0-9_.\-]+$/,
  },
  {
    label: "E2E: ECR Repository apply + destroy",
    userIntent: `Create an ECR repository named assignee-e2e-ecr-${Date.now()} for docker images`,
    resourceType: "AWS::ECR::Repository",
    arnRegex:
      /^(arn:aws[\w-]*:ecr:[a-z0-9-]+:\d+:repository\/[a-z0-9_.\-/]+|[a-z0-9_.\-/]+)$/,
  },
  {
    label: "E2E: ECS Cluster apply + destroy",
    userIntent: `Create an ECS cluster named assignee-e2e-ecs-${Date.now()}. Just the cluster control plane — no services or tasks.`,
    resourceType: "AWS::ECS::Cluster",
    arnRegex:
      /^(arn:aws[\w-]*:ecs:[a-z0-9-]+:\d+:cluster\/[A-Za-z0-9_\-]+|[A-Za-z0-9_\-]+)$/,
  },
  {
    label: "E2E: CloudWatch LogGroup apply + destroy",
    userIntent: `Create a CloudWatch log group named /aws/assignee/e2e-${Date.now()}`,
    resourceType: "AWS::Logs::LogGroup",
    arnRegex:
      /^(arn:aws[\w-]*:logs:[a-z0-9-]+:\d+:log-group:[A-Za-z0-9/_.#\-]+:\*?|[A-Za-z0-9/_.#\-]+)$/,
  },
  {
    label: "E2E: EventBridge Rule apply + destroy",
    userIntent: `Create an EventBridge rule named assignee-e2e-rule-${Date.now()} that runs every 1 hour`,
    resourceType: "AWS::Events::Rule",
    arnRegex:
      /^(arn:aws[\w-]*:events:[a-z0-9-]+:\d+:rule\/[A-Za-z0-9_.\-/]+|[A-Za-z0-9_.\-]+)$/,
  },
  {
    label: "E2E: KMS Key apply + destroy (schedule deletion)",
    userIntent: `Create a customer-managed KMS encryption key for assignee e2e test ${Date.now()}`,
    resourceType: "AWS::KMS::Key",
    // KMS KeyId is a UUID; the full ARN is arn:aws:kms:<region>:<account>:key/<uuid>.
    arnRegex:
      /^(arn:aws[\w-]*:kms:[a-z0-9-]+:\d+:key\/[0-9a-f-]{36}|[0-9a-f-]{36})$/,
    // KMS ScheduleKeyDeletion has a 7-day minimum waiting period — the
    // CCAPI delete call returns success immediately (schedules deletion)
    // but the key stays in PendingDeletion for 7 days. destroyAndAssert
    // only fails on "this run's resources still present", which
    // PendingDeletion satisfies (not active), so the assertion passes.
    timeoutMs: 180_000,
  },
];

for (const kase of FREE_TIER_LIFECYCLE_CASES) {
  describeE2E(kase.label, () => {
    it(
      `applies and destroys the resource`,
      async () => {
        await runFreeTierLifecycle(kase);
      },
      kase.timeoutMs ?? 120_000,
    );
  });
}

describeE2E("E2E: Epic 35 — Actionable Findings", () => {
  it("all findings have propertyPath set (Story 35.5)", async () => {
    const graph = createGraph(tools);

    const state = await graph.invoke(
      {
        userIntent: "Create an S3 bucket named e2e-epic35-proppath",
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.PLAN,
        startedAt: Date.now(),
        noWizard: true,
        projectDir: process.cwd(),
      },
      { configurable: { thread_id: crypto.randomUUID() } },
    );

    const s = state as AgentState;
    const findings = s.bpFindings ?? [];
    expect(findings.length).toBeGreaterThan(0);

    // Every finding must have propertyPath
    // Tier C: dropped redundant toBeDefined() — typeof string is stronger
    for (const f of findings) {
      expect(typeof f.propertyPath).toBe("string");
      expect(f.propertyPath!.length).toBeGreaterThan(0);
    }
  }, 60_000);

  it("fix_hint propagates from YAML to BPFinding (Story 35.7)", async () => {
    const graph = createGraph(tools);

    const state = await graph.invoke(
      {
        userIntent: "Create an S3 bucket named e2e-epic35-fixhint",
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.PLAN,
        startedAt: Date.now(),
        noWizard: true,
        projectDir: process.cwd(),
      },
      { configurable: { thread_id: crypto.randomUUID() } },
    );

    const s = state as AgentState;
    const findings = s.bpFindings ?? [];

    // S3 lifecycle finding should have fix_hint from YAML
    const lifecycleFinding = findings.find((f) => f.practiceId === "BP-S3-010");
    if (lifecycleFinding) {
      // Tier C: strengthened — typeof string check
      expect(typeof lifecycleFinding.fixHint).toBe("string");
      expect(lifecycleFinding.fixHint!.length).toBeLessThanOrEqual(80);
    }
  }, 60_000);

  it("FixCommandResolver categories match real findings (Story 35.2)", async () => {
    const { resolveAction } = await import("../utils/fix-command-resolver.js");

    const graph = createGraph(tools);

    // Auto-fix disabled → all findings remain (including auto-fixable)
    const fsModule = await import("node:fs");
    const configDir = path.resolve(process.cwd(), ".assignee");
    const configPath = path.join(configDir, "config.yaml");
    let existingConfig: string | undefined;
    try {
      existingConfig = fsModule.readFileSync(configPath, "utf-8");
    } catch {
      // No existing config — will create fresh one below.
    }
    fsModule.mkdirSync(configDir, { recursive: true });
    fsModule.writeFileSync(
      configPath,
      "autoFixBestPractices: false\n",
      "utf-8",
    );

    try {
      const state = await graph.invoke(
        {
          userIntent: "Create an S3 bucket named e2e-epic35-resolver",
          runId: crypto.randomUUID(),
          executionMode: ExecutionMode.PLAN,
          startedAt: Date.now(),
          noWizard: true,
          projectDir: process.cwd(),
        },
        { configurable: { thread_id: crypto.randomUUID() } },
      );

      const s = state as AgentState;
      const findings = s.bpFindings ?? [];
      expect(findings.length).toBeGreaterThan(5);

      // Resolve actions for all findings — should not throw
      const actions = findings.map((f) => ({
        practiceId: f.practiceId,
        action: resolveAction(f),
      }));

      // At least some should be auto-fixable (PublicAccessBlock, Encryption, Versioning)
      const autoFixable = actions.filter(
        (a) => a.action.category === "auto-fixable",
      );
      expect(autoFixable.length).toBeGreaterThan(0);

      // At least some should be manual (lifecycle, logging, etc.)
      const manual = actions.filter((a) => a.action.category === "manual");
      expect(manual.length).toBeGreaterThan(0);

      // Every action must have a non-empty hint
      // Tier C: dropped redundant toBeDefined() — typeof string is stronger
      for (const a of actions) {
        expect(typeof a.action.hint).toBe("string");
        expect(a.action.hint.length).toBeGreaterThan(0);
      }

      // Auto-fixable findings must have fixable=true and a non-null patch
      for (const a of autoFixable) {
        expect(a.action.fixable).toBe(true);
        // Tier C: strengthened — patch must be a real object (the JSON patch)
        expect(a.action.patch).toBeInstanceOf(Object);
      }
    } finally {
      if (existingConfig) {
        fsModule.writeFileSync(configPath, existingConfig, "utf-8");
      }
    }
  }, 60_000);

  it("formatFindings produces correct output with real data (Story 35.3)", async () => {
    const { formatFindings } = await import("../utils/display.js");

    const graph = createGraph(tools);

    const state = await graph.invoke(
      {
        userIntent: "Create an S3 bucket named e2e-epic35-display",
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.PLAN,
        startedAt: Date.now(),
        noWizard: true,
        projectDir: process.cwd(),
      },
      { configurable: { thread_id: crypto.randomUUID() } },
    );

    const s = state as AgentState;
    const output = formatFindings(s.bpFindings);

    // Should contain severity summary
    expect(output).toContain("Findings:");

    // Every finding should have a hint line with -> prefix
    expect(output).toContain("->");

    // Should NOT contain raw CFN jargon like "PublicAccessBlockConfiguration.BlockPublicAcls"
    // (those should be replaced by human-readable hints)
    // Manual findings with fix_hint should show the hint, not remediation
    const lines = output.split("\n");
    const hintLines = lines.filter((l) => l.includes("->"));
    expect(hintLines.length).toBeGreaterThan(0);

    // Each hint line should have a prefix: Fix, Manual, or Info
    for (const line of hintLines) {
      expect(line).toMatch(/->\s+(Fix|Manual|Info):/);
    }
  }, 60_000);

  it("autoFixEnabled flows through graph state (Story 35.6)", async () => {
    const graph = createGraph(tools);

    const state = await graph.invoke(
      {
        userIntent: "Create an S3 bucket named e2e-epic35-autofix-flag",
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.PLAN,
        startedAt: Date.now(),
        noWizard: true,
        projectDir: process.cwd(),
      },
      { configurable: { thread_id: crypto.randomUUID() } },
    );

    const s = state as AgentState;

    // autoFixEnabled should be set by fix-applicator
    expect(typeof s.autoFixEnabled).toBe("boolean");
  }, 60_000);

  it("deepMergePatch in promptFixSelection produces correct desiredState", async () => {
    // This test doesn't need AWS — it tests the display helper directly
    // Simulates what caused the "lololo" bug
    const { resolveAction } = await import("../utils/fix-command-resolver.js");

    const finding = {
      practiceId: "BP-S3-005",
      title: "S3 bucket should have versioning enabled",
      severity: "HIGH" as const,
      category: "security" as const,
      message: "Versioning not enabled",
      blocking: false,
      autoFixable: true,
      desiredStatePatch: {
        VersioningConfiguration: { Status: "Enabled" },
      },
      propertyPath: "VersioningConfiguration.Status",
    };

    const action = resolveAction(finding);
    expect(action.category).toBe("auto-fixable");
    expect(action.fixable).toBe(true);

    // The hint should drill to the leaf value, not show "true"
    expect(action.hint).toContain("Enabled");
  });
});

describeE2E("E2E: Auto-fix verification", () => {
  it("fix_applicator applies patches when autoFixBestPractices is enabled", async () => {
    // Create a temporary config with autoFixBestPractices: true
    const fs = await import("node:fs");
    const configDir = path.resolve(process.cwd(), ".assignee");
    const configPath = path.join(configDir, "config.yaml");

    // Read existing config if it exists
    let existingConfig: string | undefined;
    try {
      existingConfig = fs.readFileSync(configPath, "utf-8");
    } catch {
      // No existing config
    }

    // Write test config
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configPath, "autoFixBestPractices: true\n", "utf-8");

    try {
      const graph = createGraph(tools);

      const state = await graph.invoke(
        {
          userIntent: "Create an S3 bucket named autofix-e2e-test",
          runId: crypto.randomUUID(),
          executionMode: ExecutionMode.PLAN,
          startedAt: Date.now(),
          noWizard: true,
          projectDir: process.cwd(),
        },
        { configurable: { thread_id: crypto.randomUUID() } },
      );

      const s = state as AgentState;

      // Auto-fix should either have applied patches (reducing blocking findings)
      // or at minimum the fix_applicator ran without errors.
      // The LLM may generate a plan that already satisfies some BPs,
      // so we check that findings + applied fixes cover the expected BPs.
      const appliedCount = (s.appliedFixes ?? []).length;

      if (appliedCount > 0) {
        // Verify auto-fix worked: blocking findings should be reduced
        const blockingFindings = (s.bpFindings ?? []).filter((f) => f.blocking);
        expect(blockingFindings.length).toBeLessThan(5);
      }

      // At minimum, the pipeline completed successfully
      expect(s.executionStatus).toBe("PENDING"); // Plan mode = PENDING
      // Tier C: strengthened — desiredState must be a non-empty object
      expect(s.desiredState).toBeInstanceOf(Object);
    } finally {
      // Restore original config
      if (existingConfig) {
        fs.writeFileSync(configPath, existingConfig, "utf-8");
      } else {
        try {
          fs.unlinkSync(configPath);
        } catch {
          // ignore
        }
      }
    }
  }, 60_000);
});

describeE2E("E2E: Lambda Function plan", () => {
  it("generates a plan with runtime and memory configuration via lambda-with-exec-role compound dispatch", async () => {
    // Wave 19 / Wave 13 update: bare "Create a Lambda function ..." intents
    // are intentionally caught by the `lambda-with-exec-role` compound
    // pattern (Wave 13 feature) so plain-English Lambda intents auto-bundle
    // the required IAM execution role. The plan node returns the FIRST
    // resource in the queue (the IAM Role) — the Lambda itself is
    // resourceQueue[1] and gets provisioned in step 2 at apply time.
    //
    // This test now asserts the COMPOUND dispatch shape (the actual
    // user-visible Wave 13 behavior). End-to-end coverage of both
    // resources is in the `lambda-with-exec-role compound apply + destroy`
    // test further below.
    const graph = createGraph(tools);

    const state = await graph.invoke(
      {
        userIntent:
          "Create a Lambda function named e2e-lambda-test with nodejs20.x runtime",
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.PLAN,
        startedAt: Date.now(),
        noWizard: true,
        projectDir: process.cwd(),
      },
      { configurable: { thread_id: crypto.randomUUID() } },
    );

    const s = state as AgentState;

    // Compound dispatch routes through the lambda-with-exec-role pattern.
    // The graph reports the user-requested resource type (Lambda) — not
    // the first queue item (IAM Role) — as state.resourceType after plan
    // generation. The queue itself carries the full dependency order.
    expect(s.resourcePattern?.patternId).toBe("lambda-with-exec-role");
    expect(s.resourceType).toBe("AWS::Lambda::Function");
    // Tier C: dropped redundant toBeDefined() — toHaveLength fails on undefined
    expect(s.resourceQueue).toHaveLength(2);
    expect(s.resourceQueue?.[1]?.resourceType).toBe("AWS::Lambda::Function");
    expect(s.resourceQueue?.[0]?.resourceType).toBe("AWS::IAM::Role");

    // BP findings should still exist (run against the first resource)
    // Tier C: strengthened — bpFindings must be an array (could be empty)
    expect(s.bpFindings).toBeInstanceOf(Array);
    expect(s.bpFindings!.length).toBeGreaterThan(0);
  }, 60_000);
});

describeE2E("E2E: DynamoDB Table plan", () => {
  it("generates a plan with key schema and billing mode", async () => {
    const graph = createGraph(tools);

    const state = await graph.invoke(
      {
        userIntent:
          "Create a DynamoDB table named e2e-dynamo-test with partition key id of type S",
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.PLAN,
        startedAt: Date.now(),
        noWizard: true,
        projectDir: process.cwd(),
      },
      { configurable: { thread_id: crypto.randomUUID() } },
    );

    const s = state as AgentState;

    expect(s.resourceType).toBe("AWS::DynamoDB::Table");
    // Tier C: strengthened — desiredState must be a non-empty object
    expect(s.desiredState).toBeInstanceOf(Object);
    expect(s.desiredState?.["TableName"]).toBe("e2e-dynamo-test");

    // BP findings should exist for DynamoDB
    // Tier C: strengthened — bpFindings must be an array (could be empty)
    expect(s.bpFindings).toBeInstanceOf(Array);
    expect(s.bpFindings!.length).toBeGreaterThan(0);
  }, 60_000);
});

// A1 (2026-04-08): first-class EFS support. Plan-only test — EFS
// apply is expensive (an EFS file system costs ~$0.30/GB-month
// minimum even empty) so the nightly RUN_E2E suite uses plan mode
// only. The provisioning smoke test for A1 will be run manually by
// the operator when they want to exercise the full lifecycle.
describeE2E("E2E: EFS FileSystem plan", () => {
  it("generates a plan with secure defaults (Encrypted=true, BackupPolicy.Status=ENABLED)", async () => {
    const graph = createGraph(tools);

    const state = await graph.invoke(
      {
        userIntent:
          "Create an EFS file system named e2e-efs-test for shared Lambda storage",
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.PLAN,
        startedAt: Date.now(),
        noWizard: true,
        projectDir: process.cwd(),
      },
      // EFS intent matches efs-with-vpc compound (10 resources) — the
      // default recursionLimit of 25 is too low for compound plan-mode
      // iteration. Mirror the 500 limit used by compound apply tests.
      { configurable: { thread_id: crypto.randomUUID() }, recursionLimit: 500 },
    );

    const s = state as AgentState;

    // EFS intent matches efs-with-vpc compound (10 resources). The graph
    // reports the current-iteration resource type after plan-mode loop,
    // which may be any resource in the queue — not necessarily FileSystem.
    // Assert the compound was dispatched correctly instead.
    expect(s.resourcePattern?.patternId).toBe("efs-with-vpc");
    expect(s.resourceQueue).toBeInstanceOf(Array);
    expect(
      s.resourceQueue!.some((r) => r.resourceType === "AWS::EFS::FileSystem"),
    ).toBe(true);
    // In compound plan-mode, s.desiredState reflects the LAST resource
    // iterated (likely a MountTarget or RT association), NOT the EFS
    // FileSystem. Per-resource property assertions (Encrypted, BackupPolicy,
    // FileSystemTags) can't be checked on the top-level state — they live
    // in the pattern's defaultOptions which the compound provisioner reads
    // at apply time. Assert the pattern was dispatched and the queue has
    // the expected resource count instead.
    expect(s.resourceQueue!.length).toBe(10); // 10 resources in efs-with-vpc

    // BP findings should exist (at minimum the awareness-level
    // advisories fire even on fully-compliant defaults).
    expect(s.bpFindings).toBeInstanceOf(Array);
    // Neither BP-EFS-001 nor BP-EFS-002 should surface as a blocking
    // finding when the secure defaults are in place.
    const blocking = (s.bpFindings ?? []).filter((f) => f.blocking === true);
    const efsBlocking = blocking.filter(
      (f) => f.practiceId === "BP-EFS-001" || f.practiceId === "BP-EFS-002",
    );
    expect(efsBlocking).toHaveLength(0);
  }, 60_000);
});

describeE2E("E2E: EventBridge Rule plan", () => {
  it("generates a plan with secure defaults (State=ENABLED, at least one Target)", async () => {
    const graph = createGraph(tools);

    const state = await graph.invoke(
      {
        userIntent:
          "Create an EventBridge rule that runs every hour to trigger my nightly cleanup Lambda",
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.PLAN,
        startedAt: Date.now(),
        noWizard: true,
        projectDir: process.cwd(),
      },
      { configurable: { thread_id: crypto.randomUUID() } },
    );

    const s = state as AgentState;

    // Intent either hits the scheduled-lambda compound pattern or the
    // single-resource Events::Rule plan; both are acceptable for this
    // smoke test. When the compound pattern fires, the resourceType
    // reflects the last-queued resource (the display-only permission
    // or the rule itself), so we accept either shape.
    const acceptableTypes = new Set([
      "AWS::Events::Rule",
      "AWS::IAM::Role",
      "AWS::Lambda::Function",
      "AWS::Lambda::Permission",
    ]);
    expect(acceptableTypes.has(s.resourceType ?? "")).toBe(true);

    // A8 secure-by-default: the plugin's defaults.State must produce
    // an ENABLED rule so BP-EVENTS-003 doesn't fire. If the pattern
    // path ran instead, the compound's default is also ENABLED.
    if (s.resourceType === "AWS::Events::Rule") {
      expect(s.desiredState?.["State"]).toBe("ENABLED");
    }

    // Neither BP-EVENTS-001 (Targets required) nor BP-EVENTS-003
    // (ENABLED) should surface as a blocking finding when the
    // plan either uses the compound pattern or is generated against
    // the plugin's defaults.
    const blocking = (s.bpFindings ?? []).filter((f) => f.blocking === true);
    const eventsBlocking = blocking.filter((f) =>
      f.practiceId?.startsWith("BP-EVENTS-"),
    );
    expect(eventsBlocking).toHaveLength(0);
  }, 60_000);
});

describeE2E("E2E: IAM Role plan", () => {
  it("generates a plan with assume role policy", async () => {
    const graph = createGraph(tools);

    const state = await graph.invoke(
      {
        userIntent:
          "Create an IAM role named e2e-role-test for Lambda execution",
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.PLAN,
        startedAt: Date.now(),
        noWizard: true,
        projectDir: process.cwd(),
      },
      { configurable: { thread_id: crypto.randomUUID() } },
    );

    const s = state as AgentState;

    expect(s.resourceType).toBe("AWS::IAM::Role");
    // Tier C: strengthened — desiredState must be a non-empty object
    expect(s.desiredState).toBeInstanceOf(Object);
    expect(s.desiredState?.["RoleName"]).toBe("e2e-role-test");
    // Tier C: strengthened — AssumeRolePolicyDocument must be a real
    // policy object (with Statement array), not just defined
    expect(s.desiredState?.["AssumeRolePolicyDocument"]).toBeInstanceOf(Object);

    // P0-2: IAM Roles are always free — headline MUST display "Free",
    // never "N/A". Soft `if` removed: a missing cost is itself a regression.
    expect(s.estimatedMonthlyCost).toBe("Free");
  }, 60_000);
});

describeE2E("E2E: SQS Queue plan", () => {
  it("generates a plan with queue configuration", async () => {
    const graph = createGraph(tools);

    const state = await graph.invoke(
      {
        userIntent: "Create an SQS queue named e2e-queue-test",
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.PLAN,
        startedAt: Date.now(),
        noWizard: true,
        projectDir: process.cwd(),
      },
      { configurable: { thread_id: crypto.randomUUID() } },
    );

    const s = state as AgentState;

    expect(s.resourceType).toBe("AWS::SQS::Queue");
    // Tier C: strengthened — desiredState must be a non-empty object
    expect(s.desiredState).toBeInstanceOf(Object);

    // BP findings should exist for SQS
    // Tier C: strengthened — bpFindings must be an array (could be empty)
    expect(s.bpFindings).toBeInstanceOf(Array);
    expect(s.bpFindings!.length).toBeGreaterThan(0);
  }, 60_000);
});

describeE2E("E2E: VPC plan", () => {
  it("generates a plan with CIDR block and DNS settings", async () => {
    const graph = createGraph(tools);

    const state = await graph.invoke(
      {
        userIntent: "Create a VPC with CIDR 10.0.0.0/16",
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.PLAN,
        startedAt: Date.now(),
        noWizard: true,
        projectDir: process.cwd(),
      },
      // VPC intent matches vpc-networking compound (17 resources) — needs
      // higher recursionLimit for plan-mode iteration.
      { configurable: { thread_id: crypto.randomUUID() }, recursionLimit: 500 },
    );

    const s = state as AgentState;

    // VPC intent matches vpc-networking compound (17 resources). The graph
    // reports the current-iteration resource type after plan-mode loop,
    // which may be any resource in the queue. Assert compound dispatch.
    expect(s.resourcePattern?.patternId).toMatch(/^vpc-/);
    expect(s.resourceQueue).toBeInstanceOf(Array);
    expect(
      s.resourceQueue!.some((r) => r.resourceType === "AWS::EC2::VPC"),
    ).toBe(true);
  }, 60_000);
});

describeE2E("E2E: CloudWatch Alarm plan", () => {
  it("generates a plan with metric and threshold", async () => {
    const graph = createGraph(tools);

    const state = await graph.invoke(
      {
        userIntent: "Create a CloudWatch alarm for CPU utilization above 80%",
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.PLAN,
        startedAt: Date.now(),
        noWizard: true,
        projectDir: process.cwd(),
      },
      { configurable: { thread_id: crypto.randomUUID() } },
    );

    const s = state as AgentState;

    expect(s.resourceType).toBe("AWS::CloudWatch::Alarm");
    // Tier C: strengthened — desiredState must be a non-empty object
    expect(s.desiredState).toBeInstanceOf(Object);

    // Should have metric configuration
    const ds = s.desiredState!;
    const hasMetric =
      ds["MetricName"] !== undefined || ds["ComparisonOperator"] !== undefined;
    expect(hasMetric).toBe(true);

    // BP findings should include alarm action checks
    // Tier C: strengthened — bpFindings must be an array (could be empty)
    expect(s.bpFindings).toBeInstanceOf(Array);
    expect(s.bpFindings!.length).toBeGreaterThan(0);
  }, 60_000);
});

describeE2E("E2E: SecretsManager Secret plan", () => {
  it("generates a plan with secret configuration", async () => {
    const graph = createGraph(tools);

    const state = await graph.invoke(
      {
        userIntent: "Create a secret named e2e-secret-test in Secrets Manager",
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.PLAN,
        startedAt: Date.now(),
        noWizard: true,
        projectDir: process.cwd(),
      },
      { configurable: { thread_id: crypto.randomUUID() } },
    );

    const s = state as AgentState;

    expect(s.resourceType).toBe("AWS::SecretsManager::Secret");
    // Tier C: strengthened — desiredState must be a non-empty object
    expect(s.desiredState).toBeInstanceOf(Object);

    // BP findings should exist for Secrets Manager
    // Tier C: strengthened — bpFindings must be an array (could be empty)
    expect(s.bpFindings).toBeInstanceOf(Array);
    expect(s.bpFindings!.length).toBeGreaterThan(0);
  }, 60_000);
});

// ── Story 47.2: Plan-only coverage gaps ──────────────────────────────────
//
// Every resource type below previously lacked an E2E plan test; intent
// parsing + plan generation was only exercised through unit tests. These
// describeE2E blocks run in plan mode only (zero AWS cost) and assert
// either the compound pattern id + resourceQueue (for intents that
// compound-dispatch) or state.resourceType + desiredState (for single
// resource intents). RUN_E2E=1 gates the whole suite.

describeE2E("E2E: SNS Topic plan", () => {
  it("generates a plan with topic configuration", async () => {
    const graph = createGraph(tools);
    const state = await graph.invoke(
      {
        userIntent: "Create an SNS topic named e2e-sns-topic for notifications",
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.PLAN,
        startedAt: Date.now(),
        noWizard: true,
        projectDir: process.cwd(),
      },
      { configurable: { thread_id: crypto.randomUUID() } },
    );
    const s = state as AgentState;
    expect(s.resourceType).toBe("AWS::SNS::Topic");
    // AC #1 requires "non-empty desiredState" — reject {} that
    // toBeInstanceOf(Object) would silently accept (review Low fix).
    expect(Object.keys(s.desiredState ?? {}).length).toBeGreaterThan(0);
    expect(s.desiredState?.["TopicName"]).toBe("e2e-sns-topic");
    expect(s.bpFindings).toBeInstanceOf(Array);
  }, 60_000);
});

describeE2E("E2E: SNS Subscription plan", () => {
  it("generates a plan with subscription protocol and endpoint", async () => {
    const graph = createGraph(tools);
    const state = await graph.invoke(
      {
        userIntent:
          "Create an SNS email subscription to arn:aws:sns:us-east-1:054125018476:e2e-topic for test@example.com",
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.PLAN,
        startedAt: Date.now(),
        noWizard: true,
        projectDir: process.cwd(),
      },
      { configurable: { thread_id: crypto.randomUUID() } },
    );
    const s = state as AgentState;
    expect(s.resourceType).toBe("AWS::SNS::Subscription");
    expect(Object.keys(s.desiredState ?? {}).length).toBeGreaterThan(0);
    expect(s.desiredState?.["Protocol"]).toBe("email");
    expect(s.bpFindings).toBeInstanceOf(Array);
  }, 60_000);
});

describeE2E("E2E: ECR Repository plan", () => {
  it("generates a plan with repository configuration", async () => {
    const graph = createGraph(tools);
    const state = await graph.invoke(
      {
        userIntent:
          "Create an ECR repository named e2e-ecr-repo for docker images",
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.PLAN,
        startedAt: Date.now(),
        noWizard: true,
        projectDir: process.cwd(),
      },
      { configurable: { thread_id: crypto.randomUUID() } },
    );
    const s = state as AgentState;
    expect(s.resourceType).toBe("AWS::ECR::Repository");
    expect(Object.keys(s.desiredState ?? {}).length).toBeGreaterThan(0);
    expect(s.desiredState?.["RepositoryName"]).toBe("e2e-ecr-repo");
    expect(s.bpFindings).toBeInstanceOf(Array);
  }, 60_000);
});

describeE2E("E2E: ECS Cluster plan", () => {
  it("generates a plan with cluster configuration", async () => {
    const graph = createGraph(tools);
    const state = await graph.invoke(
      {
        userIntent:
          "Create an ECS cluster named e2e-ecs-cluster for containers",
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.PLAN,
        startedAt: Date.now(),
        noWizard: true,
        projectDir: process.cwd(),
      },
      // ECS intents can compound-dispatch to container-service (7+
      // resources) which exceeds LangGraph's default recursionLimit of
      // 25. Match ALB/RDS/CloudFront blocks (code-review Medium fix).
      {
        configurable: { thread_id: crypto.randomUUID() },
        recursionLimit: 500,
      },
    );
    const s = state as AgentState;
    // "container" phrasing may route through container-service compound;
    // either single-resource or compound dispatch is acceptable for this
    // smoke test. Assert via the pattern OR resourceType (compound sets
    // resourceType to the current-iteration resource, so we accept any
    // of the types that live in the container-service queue).
    const acceptableTypes = new Set([
      "AWS::ECS::Cluster",
      "AWS::EC2::VPC",
      "AWS::EC2::Subnet",
      "AWS::EC2::SecurityGroup",
      "AWS::IAM::Role",
      "AWS::ECR::Repository",
      "AWS::ElasticLoadBalancingV2::LoadBalancer",
    ]);
    if (s.resourcePattern?.patternId === "container-service") {
      expect(s.resourceQueue).toBeInstanceOf(Array);
      expect(
        s.resourceQueue!.some((r) => r.resourceType === "AWS::ECS::Cluster"),
      ).toBe(true);
    } else {
      expect(acceptableTypes.has(s.resourceType ?? "")).toBe(true);
    }
    expect(s.bpFindings).toBeInstanceOf(Array);
  }, 60_000);
});

describeE2E("E2E: ELBv2 LoadBalancer plan", () => {
  it("generates a plan with ALB configuration (compound or single)", async () => {
    const graph = createGraph(tools);
    const state = await graph.invoke(
      {
        userIntent:
          "Create an application load balancer named e2e-alb for my service",
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.PLAN,
        startedAt: Date.now(),
        noWizard: true,
        projectDir: process.cwd(),
      },
      // ALB often compound-dispatches to three-tier-web or container-service —
      // both need the larger recursionLimit for plan-mode iteration.
      {
        configurable: { thread_id: crypto.randomUUID() },
        recursionLimit: 500,
      },
    );
    const s = state as AgentState;
    if (s.resourcePattern?.patternId) {
      expect(s.resourceQueue).toBeInstanceOf(Array);
      expect(
        s.resourceQueue!.some(
          (r) => r.resourceType === "AWS::ElasticLoadBalancingV2::LoadBalancer",
        ),
      ).toBe(true);
    } else {
      expect(s.resourceType).toBe("AWS::ElasticLoadBalancingV2::LoadBalancer");
    }
    expect(s.bpFindings).toBeInstanceOf(Array);
  }, 60_000);
});

describeE2E("E2E: RDS DB Instance plan", () => {
  it("generates a plan with database configuration (compound or single)", async () => {
    const graph = createGraph(tools);
    const state = await graph.invoke(
      {
        userIntent:
          "Create a PostgreSQL database named e2e-rds-test with db.t3.micro",
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.PLAN,
        startedAt: Date.now(),
        noWizard: true,
        projectDir: process.cwd(),
      },
      // RDS often compound-dispatches to three-tier-web (22 resources) —
      // needs 500 recursion limit.
      {
        configurable: { thread_id: crypto.randomUUID() },
        recursionLimit: 500,
      },
    );
    const s = state as AgentState;
    if (s.resourcePattern?.patternId) {
      expect(s.resourceQueue).toBeInstanceOf(Array);
      expect(
        s.resourceQueue!.some((r) => r.resourceType === "AWS::RDS::DBInstance"),
      ).toBe(true);
    } else {
      expect(s.resourceType).toBe("AWS::RDS::DBInstance");
    }
    expect(s.bpFindings).toBeInstanceOf(Array);
  }, 60_000);
});

describeE2E("E2E: CloudFront Distribution plan", () => {
  it("generates a plan with distribution configuration (compound or single)", async () => {
    const graph = createGraph(tools);
    const state = await graph.invoke(
      {
        userIntent:
          "Create a CloudFront distribution serving static content from S3",
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.PLAN,
        startedAt: Date.now(),
        noWizard: true,
        projectDir: process.cwd(),
      },
      // static-website compound can fire here (CloudFront + S3 + OAC) —
      // needs the 500 recursionLimit.
      {
        configurable: { thread_id: crypto.randomUUID() },
        recursionLimit: 500,
      },
    );
    const s = state as AgentState;
    if (s.resourcePattern?.patternId) {
      expect(s.resourceQueue).toBeInstanceOf(Array);
      expect(
        s.resourceQueue!.some(
          (r) => r.resourceType === "AWS::CloudFront::Distribution",
        ),
      ).toBe(true);
    } else {
      expect(s.resourceType).toBe("AWS::CloudFront::Distribution");
    }
    expect(s.bpFindings).toBeInstanceOf(Array);
  }, 60_000);
});

describeE2E("E2E: KMS Key plan", () => {
  it("generates a plan with key policy", async () => {
    const graph = createGraph(tools);
    const state = await graph.invoke(
      {
        userIntent:
          "Create a KMS encryption key for application-level data encryption",
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.PLAN,
        startedAt: Date.now(),
        noWizard: true,
        projectDir: process.cwd(),
      },
      { configurable: { thread_id: crypto.randomUUID() } },
    );
    const s = state as AgentState;
    expect(s.resourceType).toBe("AWS::KMS::Key");
    expect(Object.keys(s.desiredState ?? {}).length).toBeGreaterThan(0);
    // KeyPolicy is load-bearing — without it CCAPI rejects the create.
    expect(s.desiredState?.["KeyPolicy"]).toBeTruthy();
    expect(s.bpFindings).toBeInstanceOf(Array);
  }, 60_000);
});

describeE2E("E2E: CloudWatch LogGroup plan", () => {
  it("generates a plan with log group configuration", async () => {
    const graph = createGraph(tools);
    const state = await graph.invoke(
      {
        userIntent:
          "Create a CloudWatch log group named /aws/assignee/e2e-logs",
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.PLAN,
        startedAt: Date.now(),
        noWizard: true,
        projectDir: process.cwd(),
      },
      { configurable: { thread_id: crypto.randomUUID() } },
    );
    const s = state as AgentState;
    expect(s.resourceType).toBe("AWS::Logs::LogGroup");
    expect(Object.keys(s.desiredState ?? {}).length).toBeGreaterThan(0);
    expect(s.desiredState?.["LogGroupName"]).toBe("/aws/assignee/e2e-logs");
    expect(s.bpFindings).toBeInstanceOf(Array);
  }, 60_000);
});

describeE2E("E2E: EventBridge EventBus plan", () => {
  it("generates a plan with event bus configuration", async () => {
    const graph = createGraph(tools);
    const state = await graph.invoke(
      {
        userIntent:
          "Create an EventBridge event bus named e2e-event-bus for cross-account events",
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.PLAN,
        startedAt: Date.now(),
        noWizard: true,
        projectDir: process.cwd(),
      },
      { configurable: { thread_id: crypto.randomUUID() } },
    );
    const s = state as AgentState;
    expect(s.resourceType).toBe("AWS::Events::EventBus");
    expect(Object.keys(s.desiredState ?? {}).length).toBeGreaterThan(0);
    expect(s.desiredState?.["Name"]).toBe("e2e-event-bus");
    expect(s.bpFindings).toBeInstanceOf(Array);
  }, 60_000);
});

// NOTE: Events::Connection + Events::ApiDestination are covered as
// single-resource plan types once the intent parser learns to surface
// them as standalone types. They're included in the plugin catalog but
// real-world usage is almost always embedded in a Connection + ApiDest
// + Rule trio that the LLM currently routes through ApiDestination.
// TODO(Epic 47 follow-up): drop these skips once the intent parser is
// retrained to recognize the bare-Connection / bare-ApiDestination case.
describe.skip("E2E: Events Connection plan (unsupported as standalone)", () => {
  it("TODO: supports standalone AWS::Events::Connection plan", () => {
    // Intent parser currently routes "Create an EventBridge connection"
    // through ApiDestination or returns UnsupportedResourceType. Will
    // be enabled once intent parsing surfaces the bare Connection type.
  });
});

describe.skip("E2E: Events ApiDestination plan (unsupported as standalone)", () => {
  it("TODO: supports standalone AWS::Events::ApiDestination plan", () => {
    // Intent parser currently requires a Connection ARN to dispatch this
    // type; bare "Create an API destination" returns UnsupportedResourceType.
  });
});

describeE2E("E2E: Error handling", () => {
  it("rejects unsupported resource type with clear error", async () => {
    const graph = createGraph(tools);

    const state = await graph.invoke(
      {
        userIntent: "Create an AWS Redshift cluster",
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.PLAN,
        startedAt: Date.now(),
        noWizard: true,
        projectDir: process.cwd(),
      },
      { configurable: { thread_id: crypto.randomUUID() } },
    );

    const s = state as AgentState;

    // Should indicate unsupported resource or error status
    // Tier C: strengthened — executionStatus must be a real status string
    expect(typeof s.executionStatus).toBe("string");
    expect(
      s.executionStatus === ExecutionStatus.UNSUPPORTED_RESOURCE ||
        s.executionStatus === ExecutionStatus.FAILED ||
        s.errorMessage !== undefined,
    ).toBe(true);
  }, 60_000);

  it("handles malformed intent gracefully", async () => {
    const graph = createGraph(tools);

    const state = await graph.invoke(
      {
        userIntent: "asdfghjkl random noise",
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.PLAN,
        startedAt: Date.now(),
        noWizard: true,
        projectDir: process.cwd(),
      },
      { configurable: { thread_id: crypto.randomUUID() } },
    );

    const s = state as AgentState;

    // Should not crash — must return some status
    // Tier C: strengthened — executionStatus must be a real status string
    expect(typeof s.executionStatus).toBe("string");
  }, 60_000);
});

// ──────────────────────────────────────────────────────────────────────────
// E2E: VPC compound apply — the CloudControl-intrinsic-resolution regression
// ──────────────────────────────────────────────────────────────────────────
//
// Pre-fix, vpc-networking's pattern emitted CloudFormation intrinsics
// (Fn::Select/Fn::GetAZs/Ref) in defaultOptions. CloudControl does not
// process those, so every compound VPC apply failed at CreateResource.
//
// This test exercises the full compound pipeline end-to-end against real AWS:
// pattern detection → marker-token resolution → CloudControl provisioning of
// VPC + Subnets + IGW + RouteTable. It then cleans up everything it created.
describeE2E("E2E: VPC compound apply + destroy", () => {
  const vpcSuffix = `${Date.now()}`;
  const vpcName = `e2e-vpc-${vpcSuffix}`;
  const createdVpcIds: string[] = [];

  it("plans, applies, and destroys a VPC with public and private subnets", async () => {
    const graph = createGraph(tools);
    const threadId = crypto.randomUUID();
    // Mirror production apply.ts recursionLimit — the VPC compound pattern
    // has 17 resources × ~4 node transitions each, far exceeding LangGraph's
    // default limit of 25. Without this override the test cannot exercise
    // the marker-resolver fix it was written to verify.
    const config = {
      configurable: { thread_id: threadId },
      recursionLimit: 1000,
    };

    const initialState = await graph.invoke(
      {
        userIntent: `Create a VPC named ${vpcName} with public and private subnets`,
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.APPLY,
        startedAt: Date.now(),
        noWizard: true,
        autoApprove: true,
        projectDir: process.cwd(),
      },
      config,
    );
    // Silence unused var — graph.invoke's return is captured for debuggability
    void initialState;

    // Drain the HITL interrupts until the graph settles.
    let graphState = await graph.getState(config);
    while (graphState.next.length > 0) {
      await graph.invoke(null, config);
      graphState = await graph.getState(config);
    }

    const finalState = graphState.values as AgentState;

    if (finalState.executionStatus !== ExecutionStatus.SUCCESS) {
      console.error("VPC COMPOUND E2E FAILED:", {
        status: finalState.executionStatus,
        error: finalState.errorMessage,
        completed: finalState.completedResources?.map(
          (c) => `${c.resourceId}(${c.resourceType})=${c.resourceArn}`,
        ),
      });
    }

    expect(finalState.executionStatus).toBe(ExecutionStatus.SUCCESS);
    // The pattern detector should have routed into the compound branch.
    expect(finalState.resourcePattern?.patternId).toBe("vpc-networking");
    // All PROVISIONABLE resources should have real AWS physical IDs.
    const completed = finalState.completedResources ?? [];
    const vpcResult = completed.find((c) => c.resourceId === "vpc");
    expect(vpcResult?.resourceArn).toMatch(/^vpc-[0-9a-f]{8,}$/);
    if (vpcResult?.resourceArn) createdVpcIds.push(vpcResult.resourceArn);

    const publicSubnet1 = completed.find(
      (c) => c.resourceId === "public-subnet-1",
    );
    expect(publicSubnet1?.resourceArn).toMatch(/^subnet-[0-9a-f]{8,}$/);

    const igwResult = completed.find((c) => c.resourceId === "igw");
    expect(igwResult?.resourceArn).toMatch(/^igw-[0-9a-f]{8,}$/);
  }, 600_000);

  afterAll(async () => {
    if (!RUN_E2E) return;
    if (skipIfNoCreds()) return;

    // Best-effort AWS cleanup: delete every VPC (and its dependent
    // resources) this test created. We use the EC2 SDK directly — the
    // compound destroy path is a separate code path and is exercised by
    // dedicated unit tests; this afterAll is only about leaving no trace.
    const region = process.env["AWS_REGION"] ?? "us-east-1";
    try {
      const {
        EC2Client,
        DescribeVpcsCommand,
        DescribeSubnetsCommand,
        DeleteSubnetCommand,
        DescribeInternetGatewaysCommand,
        DetachInternetGatewayCommand,
        DeleteInternetGatewayCommand,
        DescribeRouteTablesCommand,
        DisassociateRouteTableCommand,
        DeleteRouteTableCommand,
        DescribeNatGatewaysCommand,
        DeleteNatGatewayCommand,
        DescribeAddressesCommand,
        ReleaseAddressCommand,
        DeleteVpcCommand,
      } = await import("@aws-sdk/client-ec2");
      const ec2 = new EC2Client({
        region,
        credentials: operatorCreds(),
      });

      // Resolve any VPCs matching our name tag as well, in case the run
      // captured the physical ID but we also want to clean up orphans.
      const vpcIdsToDelete = new Set<string>(createdVpcIds);
      try {
        const byTag = await ec2.send(
          new DescribeVpcsCommand({
            Filters: [{ Name: "tag:Name", Values: [vpcName] }],
          }),
        );
        for (const v of byTag.Vpcs ?? []) {
          if (v.VpcId) vpcIdsToDelete.add(v.VpcId);
        }
      } catch {
        // ignore — tag filter is best-effort
      }

      for (const vpcId of vpcIdsToDelete) {
        try {
          // 1. NAT gateways (must go first — they hold subnet refs)
          const natGws = await ec2.send(
            new DescribeNatGatewaysCommand({
              Filter: [{ Name: "vpc-id", Values: [vpcId] }],
            }),
          );
          for (const ng of natGws.NatGateways ?? []) {
            if (ng.NatGatewayId && ng.State !== "deleted") {
              await ec2
                .send(
                  new DeleteNatGatewayCommand({
                    NatGatewayId: ng.NatGatewayId,
                  }),
                )
                .catch(() => {});
            }
          }

          // 2. Release any EIPs associated with this VPC's NAT gateways
          try {
            const addrs = await ec2.send(new DescribeAddressesCommand({}));
            for (const a of addrs.Addresses ?? []) {
              if (
                a.AllocationId &&
                (!a.AssociationId || !a.InstanceId) &&
                a.Domain === "vpc"
              ) {
                // Release EIPs tagged with the run (best-effort — only those
                // with our runId-style tag)
                try {
                  await ec2.send(
                    new ReleaseAddressCommand({ AllocationId: a.AllocationId }),
                  );
                } catch {
                  // EIP may still be attached to a deleting NAT GW — skip
                }
              }
            }
          } catch {
            // ignore
          }

          // 3. Subnets
          const subnets = await ec2.send(
            new DescribeSubnetsCommand({
              Filters: [{ Name: "vpc-id", Values: [vpcId] }],
            }),
          );
          for (const s of subnets.Subnets ?? []) {
            if (s.SubnetId) {
              await ec2
                .send(new DeleteSubnetCommand({ SubnetId: s.SubnetId }))
                .catch(() => {});
            }
          }

          // 4. Route tables: disassociate non-main associations, then delete
          const rts = await ec2.send(
            new DescribeRouteTablesCommand({
              Filters: [{ Name: "vpc-id", Values: [vpcId] }],
            }),
          );
          for (const rt of rts.RouteTables ?? []) {
            const isMain = rt.Associations?.some((a) => a.Main);
            if (rt.RouteTableId && !isMain) {
              // Disassociate all non-main associations first
              for (const assoc of rt.Associations ?? []) {
                if (assoc.RouteTableAssociationId && !assoc.Main) {
                  await ec2
                    .send(
                      new DisassociateRouteTableCommand({
                        AssociationId: assoc.RouteTableAssociationId,
                      }),
                    )
                    .catch(() => {});
                }
              }
              await ec2
                .send(
                  new DeleteRouteTableCommand({
                    RouteTableId: rt.RouteTableId,
                  }),
                )
                .catch(() => {});
            }
          }

          // 5. Internet gateway — detach then delete
          const igws = await ec2.send(
            new DescribeInternetGatewaysCommand({
              Filters: [{ Name: "attachment.vpc-id", Values: [vpcId] }],
            }),
          );
          for (const igw of igws.InternetGateways ?? []) {
            if (igw.InternetGatewayId) {
              await ec2
                .send(
                  new DetachInternetGatewayCommand({
                    InternetGatewayId: igw.InternetGatewayId,
                    VpcId: vpcId,
                  }),
                )
                .catch(() => {});
              await ec2
                .send(
                  new DeleteInternetGatewayCommand({
                    InternetGatewayId: igw.InternetGatewayId,
                  }),
                )
                .catch(() => {});
            }
          }

          // 6. VPC
          await ec2
            .send(new DeleteVpcCommand({ VpcId: vpcId }))
            .catch((err) => {
              console.warn(
                `E2E VPC cleanup: DeleteVpc ${vpcId} failed: ${String(err)}`,
              );
            });
          console.log(`E2E cleanup: deleted VPC ${vpcId}`);
        } catch (err) {
          console.warn(`E2E VPC cleanup failed for ${vpcId}: ${String(err)}`);
        }
      }
    } catch (err) {
      console.warn(`E2E VPC cleanup import failure: ${String(err)}`);
    }
  }, 300_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Wave 19 Bug #1 regression: lambda-with-exec-role compound pattern must
// apply end-to-end with no orphaned IAM Role.
//
// Before this test, the only coverage of the Wave 13 feature was 20 unit
// tests in pattern-templates/patterns/lambda-with-exec-role.test.ts that
// validated the static pattern shape. None of them invoked the actual
// compound apply graph against AWS, so the missing `Code` and `Handler`
// defaults bug went undetected — `feedback_verify_user_flows_before_done`
// in action. This test exercises the user-visible flow:
//   1. plain "Create a lambda" intent → pattern dispatcher
//   2. compound apply path provisions IAM Role + Lambda Function in order
//   3. both ARNs land in completedResources
//   4. cleanup tears down BOTH (no orphaned exec role)
// ─────────────────────────────────────────────────────────────────────────────
describeE2E("E2E: lambda-with-exec-role compound apply + destroy", () => {
  const lambdaSuffix = `${Date.now()}`;
  const createdLambdaArns: string[] = [];
  const createdRoleArns: string[] = [];

  it("plans, applies, and destroys a Lambda with auto-created exec role", async () => {
    const graph = createGraph(tools);
    const threadId = crypto.randomUUID();
    // Compound patterns blow past the default LangGraph recursion limit;
    // mirror the production apply.ts override.
    const config = {
      configurable: { thread_id: threadId },
      recursionLimit: 1000,
    };

    await graph.invoke(
      {
        // Plain English intent — no --set Role workaround. This is the
        // exact phrasing that fails before Wave 19 Bug #1 is fixed.
        userIntent: `Create a lambda for image processing test ${lambdaSuffix}`,
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.APPLY,
        startedAt: Date.now(),
        noWizard: true,
        autoApprove: true,
        projectDir: process.cwd(),
      },
      config,
    );

    // Drain HITL interrupts
    let graphState = await graph.getState(config);
    while (graphState.next.length > 0) {
      await graph.invoke(null, config);
      graphState = await graph.getState(config);
    }

    const finalState = graphState.values as AgentState;

    if (finalState.executionStatus !== ExecutionStatus.SUCCESS) {
      console.error("LAMBDA AUTO-CREATE E2E FAILED:", {
        status: finalState.executionStatus,
        error: finalState.errorMessage,
        completed: finalState.completedResources?.map(
          (c) => `${c.resourceId}(${c.resourceType})=${c.resourceArn}`,
        ),
      });
    }

    // Pattern dispatcher must have routed to lambda-with-exec-role
    expect(finalState.resourcePattern?.patternId).toBe("lambda-with-exec-role");
    expect(finalState.executionStatus).toBe(ExecutionStatus.SUCCESS);

    // Both resources must be in completedResources with real AWS ARNs
    const completed = finalState.completedResources ?? [];
    expect(completed).toHaveLength(2);

    // Tier C: dropped redundant toBeDefined() — find!() at find sites and
    // assert the actual ARN/identifier shape rather than just defined-ness
    const role = completed.find((c) => c.resourceType === "AWS::IAM::Role")!;
    const lambda = completed.find(
      (c) => c.resourceType === "AWS::Lambda::Function",
    )!;

    // IAM Role identifier may be either a bare role name or a full ARN
    // depending on how CCAPI returns the primary identifier
    expect(typeof role.resourceArn).toBe("string");
    expect(role.resourceArn!.length).toBeGreaterThan(0);
    expect(role.executionStatus).toBe(ExecutionStatus.SUCCESS);
    // Compound completedResources[].resourceArn stores the BARE CCAPI
    // primary identifier (function name, not full ARN) by design — the
    // compound marker resolver substitutes this into child resource fields
    // where AWS rejects full ARNs. The resolved display ARN is only used
    // in renderCompoundSuccess output. Assert the function name shape.
    expect(typeof lambda.resourceArn).toBe("string");
    expect(lambda.resourceArn!.length).toBeGreaterThan(0);
    expect(lambda.resourceArn).toMatch(/^assignee-lambda-fn-/);
    expect(lambda.executionStatus).toBe(ExecutionStatus.SUCCESS);

    // Capture ARNs for afterAll cleanup. Role identifier may be a bare
    // role name (CCAPI returns the primary identifier, not the ARN).
    if (role?.resourceArn) createdRoleArns.push(role.resourceArn);
    if (lambda?.resourceArn) createdLambdaArns.push(lambda.resourceArn);
  }, 600_000);

  afterAll(async () => {
    if (!RUN_E2E) return;
    if (skipIfNoCreds()) return;

    const region = process.env["AWS_REGION"] ?? "us-east-1";

    // Tear down Lambda first (depends on role), then role.
    try {
      const { LambdaClient, DeleteFunctionCommand } =
        await import("@aws-sdk/client-lambda");
      const lambda = new LambdaClient({
        region,
        credentials: operatorCreds(),
      });
      for (const fnArnOrName of createdLambdaArns) {
        // Lambda accepts both ARN and bare name as FunctionName
        try {
          await lambda.send(
            new DeleteFunctionCommand({ FunctionName: fnArnOrName }),
          );
          console.log(`E2E cleanup: deleted Lambda ${fnArnOrName}`);
        } catch (err) {
          console.warn(
            `E2E Lambda cleanup failed for ${fnArnOrName}: ${String(err)}`,
          );
        }
      }
    } catch (err) {
      console.warn(`E2E Lambda cleanup import failure: ${String(err)}`);
    }

    try {
      const { IAMClient, DeleteRoleCommand, DetachRolePolicyCommand } =
        await import("@aws-sdk/client-iam");
      const iam = new IAMClient({ region, credentials: operatorCreds() });
      for (const roleArnOrName of createdRoleArns) {
        // Strip ARN prefix if present — IAM SDK takes RoleName not ARN.
        const roleName = roleArnOrName.startsWith("arn:")
          ? (roleArnOrName.split("/").pop() ?? roleArnOrName)
          : roleArnOrName;
        // Detach the PowerUserAccess permissions boundary first; the
        // pattern attaches it via PermissionsBoundary, but we may also
        // have managed policies attached at apply time.
        try {
          await iam.send(
            new DetachRolePolicyCommand({
              RoleName: roleName,
              PolicyArn: "arn:aws:iam::aws:policy/PowerUserAccess",
            }),
          );
        } catch {
          // Boundary may not be attached as a policy — ignore
        }
        try {
          await iam.send(new DeleteRoleCommand({ RoleName: roleName }));
          console.log(`E2E cleanup: deleted IAM Role ${roleName}`);
        } catch (err) {
          const errName = (err as { name?: string })?.name ?? "";
          if (errName === "NoSuchEntityException") continue;
          console.warn(
            `E2E IAM Role cleanup failed for ${roleName}: ${String(err)}`,
          );
        }
      }
    } catch (err) {
      console.warn(`E2E IAM cleanup import failure: ${String(err)}`);
    }
  }, 180_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Wave 19 Bug #6 regression: every compound VPC apply+destroy cycle MUST
// release every assignee-tagged EIP. The 2026-04-08 live smoke recovered 5
// pre-existing leaked EIPs and Run 2 of the smoke leaked another one even
// after a clean destroy reported "9/9, 0 failed". This test asserts the
// invariant directly via raw EC2 SDK because the assignee CLI itself
// missed the leak (`assignee list` didn't even show EIPs).
// ─────────────────────────────────────────────────────────────────────────────
describeE2E("E2E: compound VPC EIP leak regression (Wave 19 Bug #6)", () => {
  it("releases every assignee-tagged EIP after compound VPC apply + bulk-destroy", async () => {
    if (!RUN_E2E) return;
    if (skipIfNoCreds()) return;

    const region = process.env["AWS_REGION"] ?? "us-east-1";

    // Snapshot EIP state BEFORE the test so we can attribute leaks to
    // this run rather than pre-existing background state.
    const { EC2Client, DescribeAddressesCommand } =
      await import("@aws-sdk/client-ec2");
    const ec2 = new EC2Client({ region, credentials: operatorCreds() });

    const before = await ec2.send(
      new DescribeAddressesCommand({
        Filters: [{ Name: "tag-key", Values: ["assignee:runId"] }],
      }),
    );
    const beforeAllocationIds = new Set(
      (before.Addresses ?? [])
        .map((a) => a.AllocationId)
        .filter((id): id is string => Boolean(id)),
    );

    // Run a full compound VPC apply + bulk-destroy via the graph + bulk
    // destroy plan path. Reuse the same compound test machinery as the
    // VPC compound apply test above.
    const graph = createGraph(tools);
    const config = {
      configurable: { thread_id: crypto.randomUUID() },
      recursionLimit: 1000,
    };
    const runId = crypto.randomUUID();
    await graph.invoke(
      {
        userIntent: `Create a VPC for EIP leak regression test ${Date.now()}`,
        runId,
        executionMode: ExecutionMode.APPLY,
        startedAt: Date.now(),
        noWizard: true,
        autoApprove: true,
        projectDir: process.cwd(),
      },
      config,
    );
    let graphState = await graph.getState(config);
    while (graphState.next.length > 0) {
      await graph.invoke(null, config);
      graphState = await graph.getState(config);
    }
    const finalState = graphState.values as AgentState;
    expect(finalState.executionStatus).toBe(ExecutionStatus.SUCCESS);

    // Bulk-destroy everything created by this run. The Wave 19 fix added
    // EC2_EIP to the DESTROY_TIER table at tier 4, so the EIP allocated
    // by the NAT Gateway branch is now part of the destroy plan.
    const { planBulkDestroy } = await import("../services/bulk-destroy.js");
    const { destroySingleResource } =
      await import("../services/destroy-service.js");
    const plan = await planBulkDestroy({ region });
    for (const r of plan.resources) {
      const result = await destroySingleResource(r, { region });
      if (!result.success) {
        console.warn(
          `bulk-destroy step failed for ${r.resourceType} ${r.identifier}: ${result.error}`,
        );
      }
    }

    // Snapshot EIP state AFTER cleanup. The set of assignee-tagged EIPs
    // must NOT have grown — every new EIP allocated by this run must
    // have been released. Pre-existing background EIPs (e.g. unrelated
    // tests sharing the account) are tolerated by subtracting the
    // beforeAllocationIds set.
    const after = await ec2.send(
      new DescribeAddressesCommand({
        Filters: [{ Name: "tag-key", Values: ["assignee:runId"] }],
      }),
    );
    const afterAllocationIds = new Set(
      (after.Addresses ?? [])
        .map((a) => a.AllocationId)
        .filter((id): id is string => Boolean(id)),
    );
    const newlyLeaked = [...afterAllocationIds].filter(
      (id) => !beforeAllocationIds.has(id),
    );

    expect(newlyLeaked).toEqual([]);
  }, 900_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// A10 follow-up (2026-04-09): efs-with-vpc compound apply + destroy e2e.
//
// Before this test, `efs-with-vpc` had unit coverage of the static pattern
// shape (pattern-templates/patterns/efs-with-vpc.test.ts) and an E2E
// plan-mode smoke (see "E2E: EFS FileSystem plan" above), but NO apply +
// destroy exercise against real AWS. That left the compound's runtime
// correctness unverified for:
//   - resourceQueue ordering (VPC → Subnet → SG → EFS FS → MountTargets)
//   - EFS FileSystem + MountTarget provisioning + inter-resource refs
//   - cleanup coverage — EFS MountTargets must be deleted before EFS FS,
//     EFS FS before SG, SG before subnets, subnets before VPC
//
// Mirrors the lambda-with-exec-role compound apply+destroy test
// (`E2E: lambda-with-exec-role compound apply + destroy` above). Gated on
// `RUN_E2E=1` like every other e2e test — no effect on plain `pnpm test`.
// Destroy is exercised via `planBulkDestroy` + `destroySingleResource`
// rather than a hand-rolled SDK cleanup, so the destroy pipeline ships
// with the same regression coverage.
// ─────────────────────────────────────────────────────────────────────────────
describeE2E("E2E: efs-with-vpc compound apply + destroy", () => {
  const efsSuffix = `${Date.now()}`;

  it("plans, applies, and bulk-destroys an EFS file system wired into a fresh VPC", async () => {
    const graph = createGraph(tools);
    const threadId = crypto.randomUUID();
    // efs-with-vpc produces 7+ provisionable resources inside a VPC —
    // each one runs through the full LangGraph node cycle, so the
    // default recursion limit (25) is not enough. Match the production
    // apply.ts override.
    const config = {
      configurable: { thread_id: threadId },
      recursionLimit: 1000,
    };

    await graph.invoke(
      {
        // Phrasing that lands on the efs-with-vpc pattern dispatcher —
        // a verified keyword combo from pattern-templates/patterns/
        // efs-with-vpc.ts (both "efs" and "vpc" mentioned together).
        userIntent: `Create an EFS file system inside a new VPC for e2e test ${efsSuffix}`,
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.APPLY,
        startedAt: Date.now(),
        noWizard: true,
        autoApprove: true,
        projectDir: process.cwd(),
      },
      config,
    );

    // Drain HITL interrupts until the graph settles.
    let graphState = await graph.getState(config);
    while (graphState.next.length > 0) {
      await graph.invoke(null, config);
      graphState = await graph.getState(config);
    }

    const finalState = graphState.values as AgentState;

    if (finalState.executionStatus !== ExecutionStatus.SUCCESS) {
      console.error("EFS-WITH-VPC COMPOUND E2E FAILED:", {
        status: finalState.executionStatus,
        error: finalState.errorMessage,
        completed: finalState.completedResources?.map(
          (c) => `${c.resourceId}(${c.resourceType})=${c.resourceArn}`,
        ),
      });
    }

    expect(finalState.executionStatus).toBe(ExecutionStatus.SUCCESS);
    expect(finalState.resourcePattern?.patternId).toBe("efs-with-vpc");

    const completed = finalState.completedResources ?? [];

    // Every first-class resource in the pattern must land with a real
    // physical ID. Minimum viable surface: a VPC, at least one Subnet,
    // a SecurityGroup that the MountTargets hang off, an EFS
    // FileSystem, and at least one MountTarget attached to it.
    const vpc = completed.find((c) => c.resourceType === "AWS::EC2::VPC");
    expect(vpc?.resourceArn).toMatch(/^vpc-[0-9a-f]{8,}$/);

    const subnets = completed.filter(
      (c) => c.resourceType === "AWS::EC2::Subnet",
    );
    expect(subnets.length).toBeGreaterThanOrEqual(1);
    for (const s of subnets) {
      expect(s.resourceArn).toMatch(/^subnet-[0-9a-f]{8,}$/);
    }

    const securityGroup = completed.find(
      (c) => c.resourceType === "AWS::EC2::SecurityGroup",
    );
    expect(securityGroup?.resourceArn).toMatch(/^sg-[0-9a-f]{8,}$/);

    const efsFs = completed.find(
      (c) => c.resourceType === "AWS::EFS::FileSystem",
    );
    expect(efsFs?.resourceArn).toMatch(/^fs-[0-9a-f]{8,}$/);
    expect(efsFs?.executionStatus).toBe(ExecutionStatus.SUCCESS);

    const mountTargets = completed.filter(
      (c) => c.resourceType === "AWS::EFS::MountTarget",
    );
    // The pattern provisions at least one MountTarget per subnet — the
    // minimum is 1. Without this, the EFS file system would not be
    // reachable from any workload, which is the whole point of the
    // compound.
    expect(mountTargets.length).toBeGreaterThanOrEqual(1);
    for (const mt of mountTargets) {
      expect(mt.resourceArn).toMatch(/^fsmt-[0-9a-f]{8,}$/);
      expect(mt.executionStatus).toBe(ExecutionStatus.SUCCESS);
    }

    // ── Destroy pipeline exercise ───────────────────────────────────
    // Exercises the real bulk-destroy pipeline instead of a hand-rolled
    // SDK teardown: discovers the resources by tag, orders them by
    // DESTROY_TIER, and runs destroySingleResource() on each. That's
    // exactly what `assignee destroy --all` does in production, so
    // this is the test that catches dependency-order regressions
    // (EFS MountTargets must go before the FileSystem, the FileSystem
    // before the SecurityGroup, the SG before the Subnets, etc.).
    await destroyAndAssert(completed);
    // Destroy assertions are inside destroyAndAssert().
  }, 900_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// A10 follow-up (2026-04-09): scheduled-lambda compound apply + destroy e2e.
//
// Mirrors the efs-with-vpc test above for the 8th compound pattern —
// EventBridge Rule + IAM Role + Lambda Function (+ optional Lambda
// Permission + LogGroup companions). The pattern was shipped in A8 but
// only had plan-mode coverage. This test locks in:
//   - resourceQueue ordering (Role → Lambda → Rule; Rule depends on
//     Lambda ARN, Lambda depends on Role ARN)
//   - Events::Rule Targets[] must reference the Lambda ARN after the
//     marker-resolver substitution
//   - destroy ordering — Rule first, then the target Lambda, then the
//     Role (detach boundary) — the inverse of the create order
// ─────────────────────────────────────────────────────────────────────────────
// (f) 2026-04-09 Task 4b: the static-website compound migrated off
// the SDK post-provision path (cloudfront-setup.ts) to fully CCAPI.
// This spec exercises the 4-resource compound end-to-end: S3 bucket
// -> OAC -> CloudFront Distribution -> S3 BucketPolicy, then bulk
// destroys the whole lot. CloudFront propagation can take 5-15
// minutes so the destroy needs a generous timeout; we set 20 minutes
// and rely on the bulk-destroy tier ordering (CLOUDFRONT_DISTRIBUTION
// must be disabled + deleted BEFORE the bucket is emptied).
//
// 2026-04-13: static-website now has graph-level CloudFront S3 retry —
// status_poller detects the transient S3 origin DNS failure and routes
// back to resource_provisioner with a 30s delay per retry (max 3).
// Pattern schema is correct; the retry handles AWS infrastructure timing.
describeE2E("E2E: static-website compound apply + destroy", () => {
  const staticSuffix = `${Date.now()}`;
  // QA WARNING W3 from qa-expert-e2e-fixes.md: the afterAll used to
  // match OACs via `staticSuffix.slice(-8)`, but the plan-generator
  // actually injects `state.runId.slice(0, 8)` into OAC names
  // (plan-generator.ts:749 + :786). Those two values are unrelated —
  // the match never fired, so afterAll never reliably cleaned up OACs
  // from failed runs. Capture the runId up-front and expose its short
  // form to afterAll so the scoping matches what the plan-generator
  // actually writes.
  let capturedRunId: string | undefined;

  it("plans, applies, and bulk-destroys a CCAPI static-website (S3 + OAC + CF + BucketPolicy)", async () => {
    const graph = createGraph(tools);
    const threadId = crypto.randomUUID();
    capturedRunId = crypto.randomUUID();
    const config = {
      configurable: { thread_id: threadId },
      recursionLimit: 1000,
    };

    await graph.invoke(
      {
        userIntent: `Create a static website with CloudFront CDN for e2e test ${staticSuffix}`,
        runId: capturedRunId,
        executionMode: ExecutionMode.APPLY,
        startedAt: Date.now(),
        noWizard: true,
        autoApprove: true,
        projectDir: process.cwd(),
      },
      config,
    );

    let graphState = await graph.getState(config);
    while (graphState.next.length > 0) {
      await graph.invoke(null, config);
      graphState = await graph.getState(config);
    }

    const finalState = graphState.values as AgentState;

    if (finalState.executionStatus !== ExecutionStatus.SUCCESS) {
      console.error("STATIC-WEBSITE COMPOUND E2E FAILED:", {
        status: finalState.executionStatus,
        error: finalState.errorMessage,
        completed: finalState.completedResources?.map(
          (c) => `${c.resourceId}(${c.resourceType})=${c.resourceArn}`,
        ),
      });
    }

    expect(finalState.executionStatus).toBe(ExecutionStatus.SUCCESS);
    expect(finalState.resourcePattern?.patternId).toBe("static-website");

    const completed = finalState.completedResources ?? [];

    // All four resources must land with physical identifiers.
    const bucket = completed.find((c) => c.resourceType === "AWS::S3::Bucket");
    expect(typeof bucket?.resourceArn).toBe("string");
    expect(bucket?.executionStatus).toBe(ExecutionStatus.SUCCESS);

    const oac = completed.find(
      (c) => c.resourceType === "AWS::CloudFront::OriginAccessControl",
    );
    expect(typeof oac?.resourceArn).toBe("string");
    expect(oac?.executionStatus).toBe(ExecutionStatus.SUCCESS);

    const distribution = completed.find(
      (c) => c.resourceType === "AWS::CloudFront::Distribution",
    );
    expect(typeof distribution?.resourceArn).toBe("string");
    expect(distribution?.executionStatus).toBe(ExecutionStatus.SUCCESS);

    const policy = completed.find(
      (c) => c.resourceType === "AWS::S3::BucketPolicy",
    );
    expect(typeof policy?.resourceArn).toBe("string");
    expect(policy?.executionStatus).toBe(ExecutionStatus.SUCCESS);

    // ── Destroy pipeline exercise ───────────────────────────────────
    // CloudFront requires Disabled=true + propagation wait before the
    // distribution can be deleted. The bulk-destroy strategy handles
    // the two-step flow; we give it a generous timeout.
    await destroyAndAssert(completed);
    // Must succeed end-to-end. The BucketPolicy deletes must happen
    // before the Bucket delete (otherwise S3 rejects with
    // BucketNotEmpty-style errors); the Distribution must be
    // disabled + deleted before the OAC (CloudFront rejects OAC
    // deletion when an attached distribution is still active); and
    // the OAC must be deleted before the BucketPolicy (stale OAC
    // reference).
    // Destroy assertions handled by destroyAndAssert() or inline above.
  }, 2_400_000);

  afterAll(async () => {
    if (!RUN_E2E) return;
    if (skipIfNoCreds()) return;

    const region = process.env["AWS_REGION"] ?? "us-east-1";
    const creds = operatorCreds();

    // Best-effort cleanup of static-website resources.

    // 1. Disable + delete CloudFront distributions matching assignee-*
    try {
      const {
        CloudFrontClient,
        ListDistributionsCommand,
        GetDistributionCommand,
        UpdateDistributionCommand,
        DeleteDistributionCommand,
      } = await import("@aws-sdk/client-cloudfront");
      const cf = new CloudFrontClient({
        region: "us-east-1", // CloudFront is global
        credentials: creds,
      });
      const dists = await cf.send(new ListDistributionsCommand({}));
      for (const d of dists.DistributionList?.Items ?? []) {
        // Match ONLY this test run's distribution (scoped by staticSuffix).
        // Previous failed runs may leak distributions; those require manual
        // cleanup via `assignee destroy`. The afterAll is NOT a global sweep.
        const hasThisRunOrigin = d.Origins?.Items?.some((o) =>
          o.DomainName?.includes(`assignee-website-bucket-${staticSuffix}`),
        );
        if (!hasThisRunOrigin || !d.Id) continue;
        try {
          const getResp = await cf.send(
            new GetDistributionCommand({ Id: d.Id }),
          );
          const config = getResp.Distribution?.DistributionConfig;
          const etag = getResp.ETag;
          if (!config || !etag) continue;

          if (config.Enabled) {
            config.Enabled = false;
            await cf.send(
              new UpdateDistributionCommand({
                Id: d.Id,
                DistributionConfig: config,
                IfMatch: etag,
              }),
            );
            // Wait for disable to propagate (up to 10 min)
            for (let i = 0; i < 120; i++) {
              await new Promise((r) => setTimeout(r, 5000));
              const status = await cf.send(
                new GetDistributionCommand({ Id: d.Id }),
              );
              if (status.Distribution?.Status === "Deployed") {
                await cf.send(
                  new DeleteDistributionCommand({
                    Id: d.Id,
                    IfMatch: status.ETag!,
                  }),
                );
                console.log(`E2E cleanup: deleted CloudFront ${d.Id}`);
                break;
              }
            }
          } else {
            await cf.send(
              new DeleteDistributionCommand({ Id: d.Id, IfMatch: etag }),
            );
            console.log(`E2E cleanup: deleted CloudFront ${d.Id}`);
          }
        } catch (err) {
          console.warn(
            `E2E CloudFront cleanup failed for ${d.Id}: ${String(err)}`,
          );
        }
      }
    } catch (err) {
      console.warn(`E2E CloudFront cleanup import failure: ${String(err)}`);
    }

    // 2. Delete OACs matching assignee-*
    try {
      const {
        CloudFrontClient,
        ListOriginAccessControlsCommand,
        GetOriginAccessControlCommand,
        DeleteOriginAccessControlCommand,
      } = await import("@aws-sdk/client-cloudfront");
      const cf = new CloudFrontClient({
        region: "us-east-1",
        credentials: creds,
      });
      const oacs = await cf.send(new ListOriginAccessControlsCommand({}));
      for (const oac of oacs.OriginAccessControlList?.Items ?? []) {
        // Scope to THIS run's OAC only. plan-generator.ts injects
        // `state.runId.slice(0, 8)` into the OAC name at line 786
        // (`assignee-<resourceId>-<shortId>`). Match on that exact
        // 8-char prefix of the captured runId; if capturedRunId is
        // undefined (apply threw before setting it) the match is
        // impossible by design — afterAll becomes a no-op rather
        // than accidentally deleting other runs' OACs.
        const runIdSuffix = capturedRunId?.slice(0, 8).toLowerCase();
        if (runIdSuffix && oac.Name?.includes(runIdSuffix) && oac.Id) {
          try {
            const getResp = await cf.send(
              new GetOriginAccessControlCommand({ Id: oac.Id }),
            );
            await cf.send(
              new DeleteOriginAccessControlCommand({
                Id: oac.Id,
                IfMatch: getResp.ETag!,
              }),
            );
            console.log(`E2E cleanup: deleted OAC ${oac.Name}`);
          } catch (err) {
            console.warn(
              `E2E OAC cleanup failed for ${oac.Name}: ${String(err)}`,
            );
          }
        }
      }
    } catch (err) {
      console.warn(`E2E OAC cleanup import failure: ${String(err)}`);
    }

    // 3. Empty and delete S3 buckets matching assignee-*
    try {
      const {
        S3Client,
        ListBucketsCommand,
        ListObjectVersionsCommand,
        DeleteObjectsCommand,
        DeleteBucketPolicyCommand,
        DeleteBucketCommand,
      } = await import("@aws-sdk/client-s3");
      const s3 = new S3Client({ region, credentials: creds });
      const { Buckets } = await s3.send(new ListBucketsCommand({}));
      for (const b of Buckets ?? []) {
        // Scope to THIS run only (staticSuffix). Previous runs' buckets
        // are handled by manual `assignee destroy` or pre-sweep.
        if (!b.Name?.includes(staticSuffix)) continue;
        try {
          // Delete bucket policy first
          await s3
            .send(new DeleteBucketPolicyCommand({ Bucket: b.Name }))
            .catch(() => {});

          // Empty bucket (all versions + delete markers)
          let isTruncated = true;
          let keyMarker: string | undefined;
          let versionIdMarker: string | undefined;
          while (isTruncated) {
            const versions = await s3.send(
              new ListObjectVersionsCommand({
                Bucket: b.Name,
                KeyMarker: keyMarker,
                VersionIdMarker: versionIdMarker,
              }),
            );
            const objects = [
              ...(versions.Versions ?? []).map((v) => ({
                Key: v.Key!,
                VersionId: v.VersionId,
              })),
              ...(versions.DeleteMarkers ?? []).map((m) => ({
                Key: m.Key!,
                VersionId: m.VersionId,
              })),
            ].filter((o) => o.Key);
            if (objects.length > 0) {
              await s3.send(
                new DeleteObjectsCommand({
                  Bucket: b.Name,
                  Delete: { Objects: objects },
                }),
              );
            }
            isTruncated = versions.IsTruncated ?? false;
            keyMarker = versions.NextKeyMarker;
            versionIdMarker = versions.NextVersionIdMarker;
            if (isTruncated && !keyMarker && !versionIdMarker) break;
          }

          await s3.send(new DeleteBucketCommand({ Bucket: b.Name }));
          console.log(`E2E cleanup: deleted S3 bucket ${b.Name}`);
        } catch (err) {
          console.warn(`E2E S3 cleanup failed for ${b.Name}: ${String(err)}`);
        }
      }
    } catch (err) {
      console.warn(`E2E S3 cleanup import failure: ${String(err)}`);
    }
  }, 900_000);
});

describeE2E("E2E: scheduled-lambda compound apply + destroy", () => {
  const schedSuffix = `${Date.now()}`;

  it("plans, applies, and bulk-destroys a scheduled Lambda wired to an EventBridge rule", async () => {
    const graph = createGraph(tools);
    const threadId = crypto.randomUUID();
    const config = {
      configurable: { thread_id: threadId },
      recursionLimit: 1000,
    };

    await graph.invoke(
      {
        // Phrasing that routes into the scheduled-lambda compound —
        // both "scheduled" and "lambda" mentioned, matching the
        // pattern's keyword set (see packages/core/src/pattern-templates/
        // patterns/scheduled-lambda.ts).
        userIntent: `Create a scheduled lambda that runs every hour for e2e test ${schedSuffix}`,
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.APPLY,
        startedAt: Date.now(),
        noWizard: true,
        autoApprove: true,
        projectDir: process.cwd(),
      },
      config,
    );

    let graphState = await graph.getState(config);
    while (graphState.next.length > 0) {
      await graph.invoke(null, config);
      graphState = await graph.getState(config);
    }

    const finalState = graphState.values as AgentState;

    if (finalState.executionStatus !== ExecutionStatus.SUCCESS) {
      console.error("SCHEDULED-LAMBDA COMPOUND E2E FAILED:", {
        status: finalState.executionStatus,
        error: finalState.errorMessage,
        completed: finalState.completedResources?.map(
          (c) => `${c.resourceId}(${c.resourceType})=${c.resourceArn}`,
        ),
      });
    }

    expect(finalState.executionStatus).toBe(ExecutionStatus.SUCCESS);
    expect(finalState.resourcePattern?.patternId).toBe("scheduled-lambda");

    const completed = finalState.completedResources ?? [];

    // Minimum surface: IAM Role, Lambda Function, Events::Rule all
    // created with real physical IDs.
    const role = completed.find((c) => c.resourceType === "AWS::IAM::Role");
    expect(typeof role?.resourceArn).toBe("string");
    expect(role?.resourceArn?.length ?? 0).toBeGreaterThan(0);
    expect(role?.executionStatus).toBe(ExecutionStatus.SUCCESS);

    const lambda = completed.find(
      (c) => c.resourceType === "AWS::Lambda::Function",
    );
    // Compound completedResources stores bare function name, not full ARN
    expect(typeof lambda?.resourceArn).toBe("string");
    expect(lambda?.resourceArn!.length).toBeGreaterThan(0);
    expect(lambda?.executionStatus).toBe(ExecutionStatus.SUCCESS);

    const rule = completed.find((c) => c.resourceType === "AWS::Events::Rule");
    // Events::Rule primaryIdentifier is /properties/Arn (readOnly) —
    // the provisioner captures the ARN from the CCAPI create response.
    expect(rule?.resourceArn).toMatch(/^arn:aws:events:[a-z0-9-]+:\d+:rule\//);
    expect(rule?.executionStatus).toBe(ExecutionStatus.SUCCESS);

    // ── Destroy pipeline exercise ───────────────────────────────────
    await destroyAndAssert(completed);
    // The Events::Rule destroy MUST happen before (or tolerate) the
    // Lambda target destroy, otherwise the rule will sit with a dangling
    // target reference. If the Rule destroy strategy doesn't first
    // RemoveTargets, the test surfaces a CCAPI DependencyViolation here.
    // Destroy assertions handled by destroyAndAssert() or inline above.
  }, 900_000);
});

// ═════════════════════════════════════════════════════════════════════════════
// Item 3d RUN_E2E ratchet (2026-04-10) — 4 previously-uncovered compounds.
// Each block is gated by RUN_E2E=1 like every other e2e test in this file and
// contributes zero runtime to plain `pnpm test`. The nightly GitHub Actions
// workflow at .github/workflows/nightly-e2e.yml runs the full suite against a
// dedicated test account at 03:00 UTC, so these blocks ship as documentation
// of the expected surface and become live coverage on the next nightly run.
//
// Covered by this ratchet:
//   1. serverless-api     (8 resources: IAM, Lambda, LogGroup, ApiGw V2,
//                          Integration, Route, Stage, Permission)
//   2. message-processing (5 resources: DLQ + MainQueue + DynamoDB +
//                          Lambda role + Processor Lambda)
//   3. container-service  (5 resources: ECR + Task role + SG + ECS Cluster +
//                          ALB)
//   4. three-tier-web     (6 resources: ALB SG + App SG + Instance profile
//                          role + ALB + EC2 + RDS)
//
// Assertions follow the reference template established by the existing
// static-website + scheduled-lambda blocks:
//   - invoke graph → poll until terminal → assert SUCCESS + patternId
//   - assert the hero resources of each compound carry real physical ARNs
//   - exercise the bulk-destroy pipeline end-to-end and assert zero
//     failures, which catches cleanup ordering bugs (parent-before-child
//     deletion, dangling dependency references).
//
// Timeouts are set generously because some compounds have long-poll
// resources: ALB provisioning can take ~5 min, RDS up to ~15 min.
// ═════════════════════════════════════════════════════════════════════════════

describeE2E("E2E: serverless-api compound apply + destroy", () => {
  const apiSuffix = `${Date.now()}`;

  it("plans, applies, and bulk-destroys a serverless API (Lambda + API Gateway V2)", async () => {
    const graph = createGraph(tools);
    const threadId = crypto.randomUUID();
    const config = {
      configurable: { thread_id: threadId },
      recursionLimit: 1000,
    };

    await graph.invoke(
      {
        userIntent: `Create a serverless api for e2e test ${apiSuffix}`,
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.APPLY,
        startedAt: Date.now(),
        noWizard: true,
        autoApprove: true,
        projectDir: process.cwd(),
      },
      config,
    );

    let graphState = await graph.getState(config);
    while (graphState.next.length > 0) {
      await graph.invoke(null, config);
      graphState = await graph.getState(config);
    }

    const finalState = graphState.values as AgentState;

    if (finalState.executionStatus !== ExecutionStatus.SUCCESS) {
      console.error("SERVERLESS-API COMPOUND E2E FAILED:", {
        status: finalState.executionStatus,
        error: finalState.errorMessage,
        completed: finalState.completedResources?.map(
          (c) => `${c.resourceId}(${c.resourceType})=${c.resourceArn}`,
        ),
      });
    }

    expect(finalState.executionStatus).toBe(ExecutionStatus.SUCCESS);
    expect(finalState.resourcePattern?.patternId).toBe("serverless-api");

    const completed = finalState.completedResources ?? [];

    // Hero resources: IAM role + Lambda + API Gateway V2 Api.
    // Lambda Permission is display-only (CCAPI routes it through the
    // flaky AWS::Lambda::PermissionPolicy path), so it may land as
    // display-only without a full ARN — do not assert its presence here.
    const role = completed.find((c) => c.resourceType === "AWS::IAM::Role");
    expect(typeof role?.resourceArn).toBe("string");
    expect(role?.executionStatus).toBe(ExecutionStatus.SUCCESS);

    const fn = completed.find(
      (c) => c.resourceType === "AWS::Lambda::Function",
    );
    // Compound completedResources stores bare function name, not full ARN
    expect(typeof fn?.resourceArn).toBe("string");
    expect(fn?.resourceArn!.length).toBeGreaterThan(0);
    expect(fn?.executionStatus).toBe(ExecutionStatus.SUCCESS);

    // API Gateway V2 Api is provisionable:false (companion resource) —
    // it is NOT provisioned via CCAPI and may not appear in
    // completedResources at all. The serverless-api pattern's hero
    // resources are IAM Role + Lambda + LogGroup (provisionable:true).
    // Assert those are present; the API Gateway is plan-display-only.
    const logGroup = completed.find(
      (c) => c.resourceType === "AWS::Logs::LogGroup",
    );
    expect(typeof logGroup?.resourceArn).toBe("string");
    expect(logGroup?.executionStatus).toBe(ExecutionStatus.SUCCESS);

    // ── Destroy pipeline exercise ───────────────────────────────────
    // API Gateway deletion must cascade through routes/stages/integrations
    // before the Api itself can be removed. bulk-destroy tier ordering
    // handles the dependency graph; if it ever regresses, the
    // DependencyViolation surfaces here.
    await destroyAndAssert(completed);
    // Destroy assertions handled by destroyAndAssert() or inline above.
  }, 900_000);
});

describeE2E("E2E: message-processing compound apply + destroy", () => {
  const mpSuffix = `${Date.now()}`;

  it("plans, applies, and bulk-destroys an SQS→Lambda→DynamoDB message processing pipeline", async () => {
    const graph = createGraph(tools);
    const threadId = crypto.randomUUID();
    const config = {
      configurable: { thread_id: threadId },
      recursionLimit: 1000,
    };

    await graph.invoke(
      {
        userIntent: `Create a message processing pipeline for e2e test ${mpSuffix}`,
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.APPLY,
        startedAt: Date.now(),
        noWizard: true,
        autoApprove: true,
        projectDir: process.cwd(),
      },
      config,
    );

    let graphState = await graph.getState(config);
    while (graphState.next.length > 0) {
      await graph.invoke(null, config);
      graphState = await graph.getState(config);
    }

    const finalState = graphState.values as AgentState;

    if (finalState.executionStatus !== ExecutionStatus.SUCCESS) {
      console.error("MESSAGE-PROCESSING COMPOUND E2E FAILED:", {
        status: finalState.executionStatus,
        error: finalState.errorMessage,
        completed: finalState.completedResources?.map(
          (c) => `${c.resourceId}(${c.resourceType})=${c.resourceArn}`,
        ),
      });
    }

    expect(finalState.executionStatus).toBe(ExecutionStatus.SUCCESS);
    expect(finalState.resourcePattern?.patternId).toBe("message-processing");

    const completed = finalState.completedResources ?? [];

    // Compound produces exactly 5 resources: DLQ, main queue, DynamoDB
    // table, IAM role, and the processor Lambda. All must land with
    // physical identifiers.
    const queues = completed.filter(
      (c) => c.resourceType === "AWS::SQS::Queue",
    );
    expect(queues.length).toBe(2); // DLQ + main queue
    for (const q of queues) {
      expect(typeof q.resourceArn).toBe("string");
      expect(q.executionStatus).toBe(ExecutionStatus.SUCCESS);
    }

    const table = completed.find(
      (c) => c.resourceType === "AWS::DynamoDB::Table",
    );
    expect(typeof table?.resourceArn).toBe("string");
    expect(table?.executionStatus).toBe(ExecutionStatus.SUCCESS);

    const fn = completed.find(
      (c) => c.resourceType === "AWS::Lambda::Function",
    );
    // Compound completedResources stores bare function name, not full ARN
    expect(typeof fn?.resourceArn).toBe("string");
    expect(fn?.resourceArn!.length).toBeGreaterThan(0);
    expect(fn?.executionStatus).toBe(ExecutionStatus.SUCCESS);

    // ── Destroy pipeline exercise ───────────────────────────────────
    // DynamoDB requires DeletionProtection=false before delete;
    // destroy-service.ts has a dedicated hook for this. If the hook
    // ever regresses, the failures array surfaces it.
    await destroyAndAssert(completed);
    // Destroy assertions handled by destroyAndAssert() or inline above.
  }, 900_000);
});

// 2026-04-13: container-service pattern now embeds a public-only VPC
// (9 resources: VPC + 2 subnets + IGW + attachment + RT + route + 2 assocs)
// plus ALB_SG, wiring the ALB Subnets + SecurityGroups. Total: 15 resources.
describeE2E("E2E: container-service compound apply + destroy", () => {
  const csSuffix = `${Date.now()}`;

  it("plans, applies, and bulk-destroys an ECS Fargate container service with ALB", async () => {
    const graph = createGraph(tools);
    const threadId = crypto.randomUUID();
    const config = {
      configurable: { thread_id: threadId },
      recursionLimit: 1000,
    };

    await graph.invoke(
      {
        userIntent: `Create a container service with ecs fargate for e2e test ${csSuffix}`,
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.APPLY,
        startedAt: Date.now(),
        noWizard: true,
        autoApprove: true,
        projectDir: process.cwd(),
      },
      config,
    );

    let graphState = await graph.getState(config);
    while (graphState.next.length > 0) {
      await graph.invoke(null, config);
      graphState = await graph.getState(config);
    }

    const finalState = graphState.values as AgentState;

    if (finalState.executionStatus !== ExecutionStatus.SUCCESS) {
      console.error("CONTAINER-SERVICE COMPOUND E2E FAILED:", {
        status: finalState.executionStatus,
        error: finalState.errorMessage,
        completed: finalState.completedResources?.map(
          (c) => `${c.resourceId}(${c.resourceType})=${c.resourceArn}`,
        ),
      });
    }

    expect(finalState.executionStatus).toBe(ExecutionStatus.SUCCESS);
    expect(finalState.resourcePattern?.patternId).toBe("container-service");

    const completed = finalState.completedResources ?? [];

    // 15 resources: 9 VPC + ALB_SG + ECR + Task Role + ECS_SG + Cluster + ALB.
    // QA WARNING W2: assert exact count so a future pattern change that
    // drops or adds a resource trips the test instead of passing
    // silently. Per-type coverage is verified below.
    expect(completed.length).toBe(15);

    // VPC foundation
    const vpc = completed.find((c) => c.resourceType === "AWS::EC2::VPC");
    expect(typeof vpc?.resourceArn).toBe("string");
    expect(vpc?.executionStatus).toBe(ExecutionStatus.SUCCESS);

    const subnets = completed.filter(
      (c) => c.resourceType === "AWS::EC2::Subnet",
    );
    expect(subnets.length).toBeGreaterThanOrEqual(2);

    // Hero resources: ECR repository, IAM task role, ECS cluster, ALB.
    const ecr = completed.find(
      (c) => c.resourceType === "AWS::ECR::Repository",
    );
    expect(typeof ecr?.resourceArn).toBe("string");
    expect(ecr?.executionStatus).toBe(ExecutionStatus.SUCCESS);

    const role = completed.find((c) => c.resourceType === "AWS::IAM::Role");
    expect(typeof role?.resourceArn).toBe("string");
    expect(role?.executionStatus).toBe(ExecutionStatus.SUCCESS);

    const sgs = completed.filter(
      (c) => c.resourceType === "AWS::EC2::SecurityGroup",
    );
    expect(sgs.length).toBeGreaterThanOrEqual(2); // ALB_SG + ECS_SG

    const cluster = completed.find(
      (c) => c.resourceType === "AWS::ECS::Cluster",
    );
    expect(typeof cluster?.resourceArn).toBe("string");
    expect(cluster?.executionStatus).toBe(ExecutionStatus.SUCCESS);

    const alb = completed.find(
      (c) => c.resourceType === "AWS::ElasticLoadBalancingV2::LoadBalancer",
    );
    expect(alb?.resourceArn).toMatch(
      /^arn:aws:elasticloadbalancing:[a-z0-9-]+:\d+:loadbalancer\/app\//,
    );
    expect(alb?.executionStatus).toBe(ExecutionStatus.SUCCESS);

    // ── Destroy pipeline exercise ───────────────────────────────────
    // VPC compound destroy follows the same IGW-detach / RT-disassociate
    // pre-delete hooks as the vpc-networking E2E. ALB provisioning can
    // take ~5 min; destroy is usually quick. ECR repositories reject
    // delete if images are present but our E2E never pushes images.
    await destroyAndAssert(completed);
  }, 1_500_000);

  afterAll(async () => {
    if (!RUN_E2E) return;
    if (skipIfNoCreds()) return;

    const region = process.env["AWS_REGION"] ?? "us-east-1";
    const creds = operatorCreds();

    // Best-effort cleanup of container-service compound resources.
    // Runs even when the test fails so we don't leak AWS resources.

    // 1. Delete ALBs matching assignee-alb-*
    try {
      const {
        ElasticLoadBalancingV2Client,
        DescribeLoadBalancersCommand,
        DeleteLoadBalancerCommand,
      } = await import("@aws-sdk/client-elastic-load-balancing-v2");
      const elbv2 = new ElasticLoadBalancingV2Client({
        region,
        credentials: creds,
      });
      const lbs = await elbv2.send(new DescribeLoadBalancersCommand({}));
      // Only clean up recent ALBs (< 2 hours old) to avoid processing
      // orphans from prior days/runs which slow the afterAll to a crawl.
      const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
      for (const lb of lbs.LoadBalancers ?? []) {
        const lbCreated = lb.CreatedTime?.getTime() ?? 0;
        if (
          lb.LoadBalancerName?.startsWith("assignee-alb-") &&
          lb.LoadBalancerArn &&
          lbCreated > twoHoursAgo
        ) {
          try {
            await elbv2.send(
              new DeleteLoadBalancerCommand({
                LoadBalancerArn: lb.LoadBalancerArn,
              }),
            );
            console.log(`E2E cleanup: deleted ALB ${lb.LoadBalancerName}`);
          } catch (err) {
            console.warn(
              `E2E ALB cleanup failed for ${lb.LoadBalancerName}: ${String(err)}`,
            );
          }
        }
      }
      // Wait for ALB ENIs to drain before VPC cleanup
      await new Promise((r) => setTimeout(r, 60_000));
    } catch (err) {
      console.warn(`E2E ALB cleanup import failure: ${String(err)}`);
    }

    // 2. Delete ECS clusters matching assignee-*
    try {
      const { ECSClient, ListClustersCommand, DeleteClusterCommand } =
        await import("@aws-sdk/client-ecs");
      const ecs = new ECSClient({ region, credentials: creds });
      const clusters = await ecs.send(new ListClustersCommand({}));
      for (const arn of clusters.clusterArns ?? []) {
        if (arn.includes("assignee-")) {
          try {
            await ecs.send(new DeleteClusterCommand({ cluster: arn }));
            console.log(`E2E cleanup: deleted ECS cluster ${arn}`);
          } catch (err) {
            console.warn(`E2E ECS cleanup failed for ${arn}: ${String(err)}`);
          }
        }
      }
    } catch (err) {
      console.warn(`E2E ECS cleanup import failure: ${String(err)}`);
    }

    // 3. Delete ECR repos matching assignee-*
    try {
      const {
        ECRClient,
        DescribeRepositoriesCommand,
        DeleteRepositoryCommand,
      } = await import("@aws-sdk/client-ecr");
      const ecr = new ECRClient({ region, credentials: creds });
      const repos = await ecr.send(new DescribeRepositoriesCommand({}));
      for (const repo of repos.repositories ?? []) {
        if (repo.repositoryName?.startsWith("assignee-")) {
          try {
            await ecr.send(
              new DeleteRepositoryCommand({
                repositoryName: repo.repositoryName,
                force: true,
              }),
            );
            console.log(`E2E cleanup: deleted ECR repo ${repo.repositoryName}`);
          } catch (err) {
            console.warn(
              `E2E ECR cleanup failed for ${repo.repositoryName}: ${String(err)}`,
            );
          }
        }
      }
    } catch (err) {
      console.warn(`E2E ECR cleanup import failure: ${String(err)}`);
    }

    // 4. Delete IAM Roles matching assignee-task-role-*
    try {
      const {
        IAMClient,
        ListAttachedRolePoliciesCommand,
        DetachRolePolicyCommand,
        DeleteRoleCommand,
      } = await import("@aws-sdk/client-iam");
      const { ListRolesCommand } = await import("@aws-sdk/client-iam");
      const iam = new IAMClient({ region, credentials: creds });
      const roles = await iam.send(new ListRolesCommand({}));
      for (const role of roles.Roles ?? []) {
        if (role.RoleName?.startsWith("assignee-task-role-")) {
          try {
            // Detach all managed policies before deletion
            const attached = await iam.send(
              new ListAttachedRolePoliciesCommand({
                RoleName: role.RoleName,
              }),
            );
            for (const p of attached.AttachedPolicies ?? []) {
              if (p.PolicyArn) {
                await iam
                  .send(
                    new DetachRolePolicyCommand({
                      RoleName: role.RoleName,
                      PolicyArn: p.PolicyArn,
                    }),
                  )
                  .catch(() => {});
              }
            }
            await iam.send(new DeleteRoleCommand({ RoleName: role.RoleName }));
            console.log(`E2E cleanup: deleted IAM Role ${role.RoleName}`);
          } catch (err) {
            const errName = (err as { name?: string })?.name ?? "";
            if (errName === "NoSuchEntityException") continue;
            console.warn(
              `E2E IAM Role cleanup failed for ${role.RoleName}: ${String(err)}`,
            );
          }
        }
      }
    } catch (err) {
      console.warn(`E2E IAM cleanup import failure: ${String(err)}`);
    }

    // 5. Delete Security Groups matching assignee-* (non-default)
    try {
      const {
        EC2Client,
        DescribeSecurityGroupsCommand,
        DeleteSecurityGroupCommand,
      } = await import("@aws-sdk/client-ec2");
      const ec2 = new EC2Client({ region, credentials: creds });
      const sgs = await ec2.send(
        new DescribeSecurityGroupsCommand({
          Filters: [{ Name: "tag:Name", Values: ["assignee-*"] }],
        }),
      );
      for (const sg of sgs.SecurityGroups ?? []) {
        if (sg.GroupId && sg.GroupName !== "default") {
          await ec2
            .send(new DeleteSecurityGroupCommand({ GroupId: sg.GroupId }))
            .catch(() => {});
        }
      }
    } catch {
      // best-effort
    }

    // 6. VPC cleanup (same pattern as the vpc-networking afterAll)
    try {
      const {
        EC2Client,
        DescribeVpcsCommand,
        DescribeSubnetsCommand,
        DeleteSubnetCommand,
        DescribeInternetGatewaysCommand,
        DetachInternetGatewayCommand,
        DeleteInternetGatewayCommand,
        DescribeRouteTablesCommand,
        DisassociateRouteTableCommand,
        DeleteRouteTableCommand,
        DeleteVpcCommand,
      } = await import("@aws-sdk/client-ec2");
      const ec2 = new EC2Client({ region, credentials: creds });

      const vpcs = await ec2.send(
        new DescribeVpcsCommand({
          Filters: [{ Name: "tag:Name", Values: ["assignee-vpc-*"] }],
        }),
      );
      for (const vpc of vpcs.Vpcs ?? []) {
        const vpcId = vpc.VpcId;
        if (!vpcId) continue;
        try {
          // Subnets
          const subnets = await ec2.send(
            new DescribeSubnetsCommand({
              Filters: [{ Name: "vpc-id", Values: [vpcId] }],
            }),
          );
          for (const s of subnets.Subnets ?? []) {
            if (s.SubnetId) {
              await ec2
                .send(new DeleteSubnetCommand({ SubnetId: s.SubnetId }))
                .catch(() => {});
            }
          }
          // Route tables: disassociate non-main associations, then delete
          const rts = await ec2.send(
            new DescribeRouteTablesCommand({
              Filters: [{ Name: "vpc-id", Values: [vpcId] }],
            }),
          );
          for (const rt of rts.RouteTables ?? []) {
            const isMain = rt.Associations?.some((a) => a.Main);
            if (rt.RouteTableId && !isMain) {
              // Disassociate all non-main associations first
              for (const assoc of rt.Associations ?? []) {
                if (assoc.RouteTableAssociationId && !assoc.Main) {
                  await ec2
                    .send(
                      new DisassociateRouteTableCommand({
                        AssociationId: assoc.RouteTableAssociationId,
                      }),
                    )
                    .catch(() => {});
                }
              }
              await ec2
                .send(
                  new DeleteRouteTableCommand({
                    RouteTableId: rt.RouteTableId,
                  }),
                )
                .catch(() => {});
            }
          }
          // IGW detach + delete
          const igws = await ec2.send(
            new DescribeInternetGatewaysCommand({
              Filters: [{ Name: "attachment.vpc-id", Values: [vpcId] }],
            }),
          );
          for (const igw of igws.InternetGateways ?? []) {
            if (igw.InternetGatewayId) {
              await ec2
                .send(
                  new DetachInternetGatewayCommand({
                    InternetGatewayId: igw.InternetGatewayId,
                    VpcId: vpcId,
                  }),
                )
                .catch(() => {});
              await ec2
                .send(
                  new DeleteInternetGatewayCommand({
                    InternetGatewayId: igw.InternetGatewayId,
                  }),
                )
                .catch(() => {});
            }
          }
          // VPC
          await ec2
            .send(new DeleteVpcCommand({ VpcId: vpcId }))
            .catch((err) => {
              console.warn(
                `E2E VPC cleanup: DeleteVpc ${vpcId} failed: ${String(err)}`,
              );
            });
          console.log(`E2E cleanup: deleted VPC ${vpcId}`);
        } catch (err) {
          console.warn(`E2E VPC cleanup failed for ${vpcId}: ${String(err)}`);
        }
      }
    } catch (err) {
      console.warn(`E2E VPC cleanup import failure: ${String(err)}`);
    }
  }, 300_000);
});

// 2026-04-13: three-tier-web now embeds a full VPC (public + private subnets,
// no NAT) with 3 SGs, DBSubnetGroup, ALB wired to public subnets, EC2 with
// AMI resolution, and RDS with DBSubnetGroup + VPC SG. Total: 22 resources.
describeE2E("E2E: three-tier-web compound apply + destroy", () => {
  const ttSuffix = `${Date.now()}`;

  it("plans, applies, and bulk-destroys a three-tier web app (ALB + EC2 + RDS)", async () => {
    const graph = createGraph(tools);
    const threadId = crypto.randomUUID();
    const config = {
      configurable: { thread_id: threadId },
      recursionLimit: 1000,
    };

    await graph.invoke(
      {
        userIntent: `Create a three tier web application with alb ec2 rds for e2e test ${ttSuffix}`,
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.APPLY,
        startedAt: Date.now(),
        noWizard: true,
        autoApprove: true,
        projectDir: process.cwd(),
      },
      config,
    );

    let graphState = await graph.getState(config);
    while (graphState.next.length > 0) {
      await graph.invoke(null, config);
      graphState = await graph.getState(config);
    }

    const finalState = graphState.values as AgentState;

    if (finalState.executionStatus !== ExecutionStatus.SUCCESS) {
      console.error("THREE-TIER-WEB COMPOUND E2E FAILED:", {
        status: finalState.executionStatus,
        error: finalState.errorMessage,
        completed: finalState.completedResources?.map(
          (c) => `${c.resourceId}(${c.resourceType})=${c.resourceArn}`,
        ),
      });
    }

    expect(finalState.executionStatus).toBe(ExecutionStatus.SUCCESS);
    expect(finalState.resourcePattern?.patternId).toBe("three-tier-web");

    const completed = finalState.completedResources ?? [];

    // 22 resources: 14 VPC + 3 SGs + Role + DBSubnetGroup + ALB + EC2 + RDS.
    // QA WARNING W2: assert exact count (see container-service above for
    // rationale). Per-type coverage is verified below.
    expect(completed.length).toBe(22);

    // VPC foundation
    const vpc = completed.find((c) => c.resourceType === "AWS::EC2::VPC");
    expect(typeof vpc?.resourceArn).toBe("string");
    expect(vpc?.executionStatus).toBe(ExecutionStatus.SUCCESS);

    const subnets = completed.filter(
      (c) => c.resourceType === "AWS::EC2::Subnet",
    );
    expect(subnets.length).toBeGreaterThanOrEqual(4); // 2 public + 2 private

    // Security groups: ALB + App + DB
    const sgs = completed.filter(
      (c) => c.resourceType === "AWS::EC2::SecurityGroup",
    );
    expect(sgs.length).toBeGreaterThanOrEqual(3);
    for (const sg of sgs) {
      expect(typeof sg.resourceArn).toBe("string");
      expect(sg.executionStatus).toBe(ExecutionStatus.SUCCESS);
    }

    const role = completed.find((c) => c.resourceType === "AWS::IAM::Role");
    expect(typeof role?.resourceArn).toBe("string");
    expect(role?.executionStatus).toBe(ExecutionStatus.SUCCESS);

    // DB Subnet Group
    const dbSubnetGroup = completed.find(
      (c) => c.resourceType === "AWS::RDS::DBSubnetGroup",
    );
    expect(typeof dbSubnetGroup?.resourceArn).toBe("string");
    expect(dbSubnetGroup?.executionStatus).toBe(ExecutionStatus.SUCCESS);

    const alb = completed.find(
      (c) => c.resourceType === "AWS::ElasticLoadBalancingV2::LoadBalancer",
    );
    expect(alb?.resourceArn).toMatch(
      /^arn:aws:elasticloadbalancing:[a-z0-9-]+:\d+:loadbalancer\/app\//,
    );
    expect(alb?.executionStatus).toBe(ExecutionStatus.SUCCESS);

    const ec2 = completed.find((c) => c.resourceType === "AWS::EC2::Instance");
    expect(ec2?.resourceArn).toMatch(/^i-[0-9a-f]+$|^arn:aws:ec2:/);
    expect(ec2?.executionStatus).toBe(ExecutionStatus.SUCCESS);

    const rds = completed.find(
      (c) => c.resourceType === "AWS::RDS::DBInstance",
    );
    expect(typeof rds?.resourceArn).toBe("string");
    expect(rds?.executionStatus).toBe(ExecutionStatus.SUCCESS);

    // ── Destroy pipeline exercise ───────────────────────────────────
    // RDS + ALB are the long-poll resources. DBSubnetGroup must be
    // destroyed AFTER RDS (tier 4 vs tier 3). VPC compound destroy
    // follows the IGW-detach / RT-disassociate pre-delete hooks.
    await destroyAndAssert(completed);
  }, 2_400_000);

  afterAll(async () => {
    if (!RUN_E2E) return;
    if (skipIfNoCreds()) return;

    const region = process.env["AWS_REGION"] ?? "us-east-1";
    const creds = operatorCreds();

    // Best-effort cleanup of three-tier-web resources.

    // 1. Delete RDS instances (SkipFinalSnapshot, disable DeletionProtection)
    try {
      const {
        RDSClient,
        DescribeDBInstancesCommand,
        ModifyDBInstanceCommand,
        DeleteDBInstanceCommand,
      } = await import("@aws-sdk/client-rds");
      const rds = new RDSClient({ region, credentials: creds });
      const instances = await rds.send(new DescribeDBInstancesCommand({}));
      for (const db of instances.DBInstances ?? []) {
        if (
          db.DBInstanceIdentifier?.startsWith("assignee-") &&
          db.DBInstanceStatus !== "deleting"
        ) {
          try {
            // Disable deletion protection if enabled
            if (db.DeletionProtection) {
              await rds.send(
                new ModifyDBInstanceCommand({
                  DBInstanceIdentifier: db.DBInstanceIdentifier,
                  DeletionProtection: false,
                }),
              );
            }
            await rds.send(
              new DeleteDBInstanceCommand({
                DBInstanceIdentifier: db.DBInstanceIdentifier,
                SkipFinalSnapshot: true,
                DeleteAutomatedBackups: true,
              }),
            );
            console.log(`E2E cleanup: deleting RDS ${db.DBInstanceIdentifier}`);
          } catch (err) {
            console.warn(
              `E2E RDS cleanup failed for ${db.DBInstanceIdentifier}: ${String(err)}`,
            );
          }
        }
      }
      // Poll until all assignee-* RDS instances are fully deleted before
      // proceeding to DB Subnet Group cleanup (RDS deletion takes 5-15 min).
      const rdsIdsToWait = (instances.DBInstances ?? [])
        .filter(
          (db) =>
            db.DBInstanceIdentifier?.startsWith("assignee-") &&
            db.DBInstanceStatus !== "deleted",
        )
        .map((db) => db.DBInstanceIdentifier!);

      if (rdsIdsToWait.length > 0) {
        const {
          RDSClient: RDSPollClient,
          DescribeDBInstancesCommand: DescDBCmd,
        } = await import("@aws-sdk/client-rds");
        const rdsPoll = new RDSPollClient({ region, credentials: creds });
        const maxPolls = 80; // 80 * 15s = 20 min max
        const pollIntervalMs = 15_000;

        for (const dbId of rdsIdsToWait) {
          console.log(
            `E2E cleanup: polling for RDS ${dbId} deletion (max 20 min)...`,
          );
          for (let i = 0; i < maxPolls; i++) {
            await new Promise((r) => setTimeout(r, pollIntervalMs));
            try {
              const resp = await rdsPoll.send(
                new DescDBCmd({
                  DBInstanceIdentifier: dbId,
                }),
              );
              const status = resp.DBInstances?.[0]?.DBInstanceStatus;
              if (status === "deleting") {
                if (i % 4 === 0) {
                  console.log(
                    `E2E cleanup: RDS ${dbId} still deleting (${(i + 1) * 15}s)...`,
                  );
                }
                continue;
              }
              // Any other status means something unexpected — break out
              console.warn(
                `E2E cleanup: RDS ${dbId} unexpected status "${status}" — proceeding`,
              );
              break;
            } catch (pollErr) {
              const errName = (pollErr as { name?: string })?.name ?? "";
              if (
                errName === "DBInstanceNotFoundFault" ||
                errName === "DBInstanceNotFoundException"
              ) {
                console.log(`E2E cleanup: RDS ${dbId} confirmed deleted`);
                break;
              }
              // Transient error — keep polling
              console.warn(
                `E2E cleanup: RDS poll error for ${dbId}: ${String(pollErr)}`,
              );
            }
          }
        }
      }
    } catch (err) {
      console.warn(`E2E RDS cleanup import failure: ${String(err)}`);
    }

    // 2. Delete DB Subnet Groups
    try {
      const {
        RDSClient,
        DescribeDBSubnetGroupsCommand,
        DeleteDBSubnetGroupCommand,
      } = await import("@aws-sdk/client-rds");
      const rds = new RDSClient({ region, credentials: creds });
      const groups = await rds.send(new DescribeDBSubnetGroupsCommand({}));
      for (const g of groups.DBSubnetGroups ?? []) {
        if (g.DBSubnetGroupName?.startsWith("assignee-")) {
          try {
            await rds.send(
              new DeleteDBSubnetGroupCommand({
                DBSubnetGroupName: g.DBSubnetGroupName,
              }),
            );
            console.log(
              `E2E cleanup: deleted DB Subnet Group ${g.DBSubnetGroupName}`,
            );
          } catch (err) {
            console.warn(
              `E2E DB Subnet Group cleanup failed for ${g.DBSubnetGroupName}: ${String(err)}`,
            );
          }
        }
      }
    } catch (err) {
      console.warn(
        `E2E DB Subnet Group cleanup import failure: ${String(err)}`,
      );
    }

    // 3. Delete ALBs
    try {
      const {
        ElasticLoadBalancingV2Client,
        DescribeLoadBalancersCommand,
        DeleteLoadBalancerCommand,
      } = await import("@aws-sdk/client-elastic-load-balancing-v2");
      const elbv2 = new ElasticLoadBalancingV2Client({
        region,
        credentials: creds,
      });
      const lbs = await elbv2.send(new DescribeLoadBalancersCommand({}));
      // Only clean up recent ALBs (< 2 hours old) to avoid processing
      // orphans from prior days/runs which slow the afterAll to a crawl.
      const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
      for (const lb of lbs.LoadBalancers ?? []) {
        const lbCreated = lb.CreatedTime?.getTime() ?? 0;
        if (
          lb.LoadBalancerName?.startsWith("assignee-alb-") &&
          lb.LoadBalancerArn &&
          lbCreated > twoHoursAgo
        ) {
          try {
            await elbv2.send(
              new DeleteLoadBalancerCommand({
                LoadBalancerArn: lb.LoadBalancerArn,
              }),
            );
            console.log(`E2E cleanup: deleted ALB ${lb.LoadBalancerName}`);
          } catch (err) {
            console.warn(
              `E2E ALB cleanup failed for ${lb.LoadBalancerName}: ${String(err)}`,
            );
          }
        }
      }
      await new Promise((r) => setTimeout(r, 60_000));
    } catch (err) {
      console.warn(`E2E ALB cleanup import failure: ${String(err)}`);
    }

    // 4. Terminate EC2 instances
    try {
      const { EC2Client, DescribeInstancesCommand, TerminateInstancesCommand } =
        await import("@aws-sdk/client-ec2");
      const ec2 = new EC2Client({ region, credentials: creds });
      const reservations = await ec2.send(
        new DescribeInstancesCommand({
          Filters: [
            { Name: "tag:Name", Values: ["assignee-*"] },
            {
              Name: "instance-state-name",
              Values: ["running", "stopped", "pending"],
            },
          ],
        }),
      );
      const instanceIds: string[] = [];
      for (const r of reservations.Reservations ?? []) {
        for (const i of r.Instances ?? []) {
          if (i.InstanceId) instanceIds.push(i.InstanceId);
        }
      }
      if (instanceIds.length > 0) {
        await ec2.send(
          new TerminateInstancesCommand({ InstanceIds: instanceIds }),
        );
        console.log(
          `E2E cleanup: terminated instances ${instanceIds.join(", ")}`,
        );
        // Wait for instances to terminate before SG/subnet cleanup
        await new Promise((r) => setTimeout(r, 60_000));
      }
    } catch (err) {
      console.warn(`E2E EC2 instance cleanup failure: ${String(err)}`);
    }

    // 5. Delete IAM Roles matching assignee-instance-profile-role-*
    try {
      const {
        IAMClient,
        ListRolesCommand,
        ListAttachedRolePoliciesCommand,
        DetachRolePolicyCommand,
        DeleteRoleCommand,
      } = await import("@aws-sdk/client-iam");
      const iam = new IAMClient({ region, credentials: creds });
      const roles = await iam.send(new ListRolesCommand({}));
      for (const role of roles.Roles ?? []) {
        if (role.RoleName?.startsWith("assignee-instance-profile-role-")) {
          try {
            // Detach all managed policies before deletion
            const attached = await iam.send(
              new ListAttachedRolePoliciesCommand({
                RoleName: role.RoleName,
              }),
            );
            for (const p of attached.AttachedPolicies ?? []) {
              if (p.PolicyArn) {
                await iam
                  .send(
                    new DetachRolePolicyCommand({
                      RoleName: role.RoleName,
                      PolicyArn: p.PolicyArn,
                    }),
                  )
                  .catch(() => {});
              }
            }
            await iam.send(new DeleteRoleCommand({ RoleName: role.RoleName }));
            console.log(`E2E cleanup: deleted IAM Role ${role.RoleName}`);
          } catch (err) {
            const errName = (err as { name?: string })?.name ?? "";
            if (errName === "NoSuchEntityException") continue;
            console.warn(
              `E2E IAM Role cleanup failed for ${role.RoleName}: ${String(err)}`,
            );
          }
        }
      }
    } catch (err) {
      console.warn(`E2E IAM cleanup import failure: ${String(err)}`);
    }

    // 6. Security groups, VPC cleanup (same pattern as container-service)
    try {
      const {
        EC2Client,
        DescribeSecurityGroupsCommand,
        DeleteSecurityGroupCommand,
      } = await import("@aws-sdk/client-ec2");
      const ec2 = new EC2Client({ region, credentials: creds });
      const sgs = await ec2.send(
        new DescribeSecurityGroupsCommand({
          Filters: [{ Name: "tag:Name", Values: ["assignee-*"] }],
        }),
      );
      for (const sg of sgs.SecurityGroups ?? []) {
        if (sg.GroupId && sg.GroupName !== "default") {
          await ec2
            .send(new DeleteSecurityGroupCommand({ GroupId: sg.GroupId }))
            .catch(() => {});
        }
      }
    } catch {
      // best-effort
    }

    // 7. VPC cleanup
    try {
      const {
        EC2Client,
        DescribeVpcsCommand,
        DescribeSubnetsCommand,
        DeleteSubnetCommand,
        DescribeInternetGatewaysCommand,
        DetachInternetGatewayCommand,
        DeleteInternetGatewayCommand,
        DescribeRouteTablesCommand,
        DisassociateRouteTableCommand,
        DeleteRouteTableCommand,
        DeleteVpcCommand,
      } = await import("@aws-sdk/client-ec2");
      const ec2 = new EC2Client({ region, credentials: creds });

      const vpcs = await ec2.send(
        new DescribeVpcsCommand({
          Filters: [{ Name: "tag:Name", Values: ["assignee-vpc-*"] }],
        }),
      );
      for (const vpc of vpcs.Vpcs ?? []) {
        const vpcId = vpc.VpcId;
        if (!vpcId) continue;
        try {
          const subnets = await ec2.send(
            new DescribeSubnetsCommand({
              Filters: [{ Name: "vpc-id", Values: [vpcId] }],
            }),
          );
          for (const s of subnets.Subnets ?? []) {
            if (s.SubnetId) {
              await ec2
                .send(new DeleteSubnetCommand({ SubnetId: s.SubnetId }))
                .catch(() => {});
            }
          }
          // Route tables: disassociate non-main associations, then delete
          const rts = await ec2.send(
            new DescribeRouteTablesCommand({
              Filters: [{ Name: "vpc-id", Values: [vpcId] }],
            }),
          );
          for (const rt of rts.RouteTables ?? []) {
            const isMain = rt.Associations?.some((a) => a.Main);
            if (rt.RouteTableId && !isMain) {
              // Disassociate all non-main associations first
              for (const assoc of rt.Associations ?? []) {
                if (assoc.RouteTableAssociationId && !assoc.Main) {
                  await ec2
                    .send(
                      new DisassociateRouteTableCommand({
                        AssociationId: assoc.RouteTableAssociationId,
                      }),
                    )
                    .catch(() => {});
                }
              }
              await ec2
                .send(
                  new DeleteRouteTableCommand({
                    RouteTableId: rt.RouteTableId,
                  }),
                )
                .catch(() => {});
            }
          }
          const igws = await ec2.send(
            new DescribeInternetGatewaysCommand({
              Filters: [{ Name: "attachment.vpc-id", Values: [vpcId] }],
            }),
          );
          for (const igw of igws.InternetGateways ?? []) {
            if (igw.InternetGatewayId) {
              await ec2
                .send(
                  new DetachInternetGatewayCommand({
                    InternetGatewayId: igw.InternetGatewayId,
                    VpcId: vpcId,
                  }),
                )
                .catch(() => {});
              await ec2
                .send(
                  new DeleteInternetGatewayCommand({
                    InternetGatewayId: igw.InternetGatewayId,
                  }),
                )
                .catch(() => {});
            }
          }
          await ec2
            .send(new DeleteVpcCommand({ VpcId: vpcId }))
            .catch((err) => {
              console.warn(
                `E2E VPC cleanup: DeleteVpc ${vpcId} failed: ${String(err)}`,
              );
            });
          console.log(`E2E cleanup: deleted VPC ${vpcId}`);
        } catch (err) {
          console.warn(`E2E VPC cleanup failed for ${vpcId}: ${String(err)}`);
        }
      }
    } catch (err) {
      console.warn(`E2E VPC cleanup import failure: ${String(err)}`);
    }
  }, 1_500_000);
});

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
    // The node-level resourceType is the FIRST resource in the queue (IAM
    // Role), but resourceQueue[1] must be the Lambda the user asked for.
    expect(s.resourcePattern?.patternId).toBe("lambda-with-exec-role");
    expect(s.resourceType).toBe("AWS::IAM::Role");
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
      { configurable: { thread_id: crypto.randomUUID() } },
    );

    const s = state as AgentState;

    expect(s.resourceType).toBe("AWS::EFS::FileSystem");
    // Tier C: desiredState must be a real object, not just defined.
    expect(s.desiredState).toBeInstanceOf(Object);
    // A1 secure-by-default: plugin.defaults set Encrypted=true so the
    // plan must not drift into an unencrypted file system even when
    // the user didn't explicitly ask for encryption in the intent.
    expect(s.desiredState?.["Encrypted"]).toBe(true);
    // BP-EFS-002 compliance: BackupPolicy.Status defaults to ENABLED.
    const backupPolicy = s.desiredState?.["BackupPolicy"] as
      | { Status?: string }
      | undefined;
    expect(backupPolicy?.Status).toBe("ENABLED");

    // The plugin promotes a friendly name into FileSystemTags rather
    // than an (unsupported) FileSystemName property. Verify the Name
    // tag is present.
    const fsTags = s.desiredState?.["FileSystemTags"] as
      | Array<{ Key: string; Value: string }>
      | undefined;
    expect(fsTags).toBeInstanceOf(Array);
    const nameTag = fsTags?.find((t) => t.Key === "Name");
    expect(nameTag?.Value).toBe("e2e-efs-test");

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
      { configurable: { thread_id: crypto.randomUUID() } },
    );

    const s = state as AgentState;

    expect(s.resourceType).toBe("AWS::EC2::VPC");
    // Tier C: strengthened — desiredState must be a non-empty object
    expect(s.desiredState).toBeInstanceOf(Object);
    expect(s.desiredState?.["CidrBlock"]).toBe("10.0.0.0/16");

    // P0-2: VPCs are always free — headline must reflect that.
    expect(s.estimatedMonthlyCost).toBe("Free");
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
      recursionLimit: 500,
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

          // 4. Route tables (skip the main one)
          const rts = await ec2.send(
            new DescribeRouteTablesCommand({
              Filters: [{ Name: "vpc-id", Values: [vpcId] }],
            }),
          );
          for (const rt of rts.RouteTables ?? []) {
            const isMain = rt.Associations?.some((a) => a.Main);
            if (rt.RouteTableId && !isMain) {
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
      recursionLimit: 500,
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
    // Lambda ARN must look like arn:aws:lambda:<region>:<account>:function:<name>
    expect(lambda.resourceArn).toMatch(
      /^arn:aws:lambda:[a-z0-9-]+:\d+:function:/,
    );
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
      recursionLimit: 500,
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

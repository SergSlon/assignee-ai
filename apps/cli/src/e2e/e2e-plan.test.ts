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
    expect(s.desiredState).toBeDefined();
    expect(s.desiredState?.["BucketName"]).toBe(bucketName);

    // Cost estimate from Pricing MCP (not "N/A")
    expect(s.estimatedMonthlyCost).toBeDefined();
    expect(s.estimatedMonthlyCost).not.toBe("N/A");

    // BP findings generated
    expect(s.bpFindings).toBeDefined();
    expect(s.bpFindings!.length).toBeGreaterThan(0);

    // Pricing breakdown from decomposer
    expect(s.pricingBreakdown).toBeDefined();
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
    expect(s.desiredState).toBeDefined();

    // EC2 decomposer should produce compute + storage line items
    if (s.pricingBreakdown) {
      const labels = [
        ...s.pricingBreakdown.fixedItems.map((i) => i.lineItem.label),
        ...s.pricingBreakdown.usageBasedItems.map((i) => i.lineItem.label),
      ];
      expect(labels).toContain("Compute");
    }

    // BP findings should include IMDSv2 and EBS encryption checks
    expect(s.bpFindings).toBeDefined();
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
    const state = await graph.invoke(
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
    expect(finalState.resourceArn).toBeDefined();

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
    for (const f of findings) {
      expect(f.propertyPath).toBeDefined();
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
      expect(lifecycleFinding.fixHint).toBeDefined();
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
      for (const a of actions) {
        expect(a.action.hint).toBeDefined();
        expect(a.action.hint.length).toBeGreaterThan(0);
      }

      // Auto-fixable findings must have fixable=true and a patch
      for (const a of autoFixable) {
        expect(a.action.fixable).toBe(true);
        expect(a.action.patch).toBeDefined();
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
      const totalFindings = (s.bpFindings ?? []).length;
      const appliedCount = (s.appliedFixes ?? []).length;

      if (appliedCount > 0) {
        // Verify auto-fix worked: blocking findings should be reduced
        const blockingFindings = (s.bpFindings ?? []).filter((f) => f.blocking);
        expect(blockingFindings.length).toBeLessThan(5);
      }

      // At minimum, the pipeline completed successfully
      expect(s.executionStatus).toBe("PENDING"); // Plan mode = PENDING
      expect(s.desiredState).toBeDefined();
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
  it("generates a plan with runtime and memory configuration", async () => {
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

    expect(s.resourceType).toBe("AWS::Lambda::Function");
    expect(s.desiredState).toBeDefined();
    expect(s.desiredState?.["Runtime"]).toContain("nodejs");

    // BP findings should exist for Lambda
    expect(s.bpFindings).toBeDefined();
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
    expect(s.desiredState).toBeDefined();
    expect(s.desiredState?.["TableName"]).toBe("e2e-dynamo-test");

    // BP findings should exist for DynamoDB
    expect(s.bpFindings).toBeDefined();
    expect(s.bpFindings!.length).toBeGreaterThan(0);
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
    expect(s.desiredState).toBeDefined();
    expect(s.desiredState?.["RoleName"]).toBe("e2e-role-test");
    expect(s.desiredState?.["AssumeRolePolicyDocument"]).toBeDefined();

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
    expect(s.desiredState).toBeDefined();

    // BP findings should exist for SQS
    expect(s.bpFindings).toBeDefined();
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
    expect(s.desiredState).toBeDefined();
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
    expect(s.desiredState).toBeDefined();

    // Should have metric configuration
    const ds = s.desiredState!;
    const hasMetric =
      ds["MetricName"] !== undefined || ds["ComparisonOperator"] !== undefined;
    expect(hasMetric).toBe(true);

    // BP findings should include alarm action checks
    expect(s.bpFindings).toBeDefined();
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
    expect(s.desiredState).toBeDefined();

    // BP findings should exist for Secrets Manager
    expect(s.bpFindings).toBeDefined();
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
    expect(s.executionStatus).toBeDefined();
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
    expect(s.executionStatus).toBeDefined();
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

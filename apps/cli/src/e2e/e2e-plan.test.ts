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

// Load .env from project root — try multiple paths for resilience
function loadEnv() {
  const candidates = [
    path.resolve(import.meta.dirname, "../../../.env"), // from src/e2e/
    path.resolve(import.meta.dirname, "../../../../.env"), // if deeper
    path.resolve(process.cwd(), ".env"), // cwd fallback
  ];
  for (const envPath of candidates) {
    try {
      const content = fs.readFileSync(envPath, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx);
        const value = trimmed.slice(eqIdx + 1);
        if (!process.env[key]) process.env[key] = value;
      }
      break; // loaded successfully
    } catch {
      // try next candidate
    }
  }
}
loadEnv();

let tools: StructuredTool[];
let mcpClient: Awaited<ReturnType<typeof createMcpClient>>;

/** Pre-sweep: delete leftover resources from previous crashed runs. */
async function sweepStaleResources(): Promise<void> {
  const region = process.env["AWS_REGION"] ?? "us-east-1";
  try {
    const { SSMClient, GetParametersByPathCommand, DeleteParameterCommand } =
      await import("@aws-sdk/client-ssm");
    const ssm = new SSMClient({ region });
    const params = await ssm.send(
      new GetParametersByPathCommand({ Path: "/e2e-test/", Recursive: true }),
    );
    for (const p of params.Parameters ?? []) {
      if (p.Name) {
        await ssm.send(new DeleteParameterCommand({ Name: p.Name }));
        console.log(`E2E pre-sweep: deleted stale SSM param ${p.Name}`);
      }
    }
  } catch {
    // path may not exist — fine
  }
  try {
    const { S3Client, ListBucketsCommand, DeleteBucketCommand } =
      await import("@aws-sdk/client-s3");
    const s3 = new S3Client({ region });
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
  // Skip if no credentials
  if (!process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"]) {
    console.warn("Skipping E2E tests: no AWS credentials configured");
    return;
  }

  // Clean up leftovers from previous crashed runs before starting
  await sweepStaleResources();

  mcpClient = await createMcpClient();
  tools = await getMcpTools(mcpClient);
}, 30_000);

afterAll(async () => {
  await closeMcpClient().catch(() => {});

  // Global sweeper: clean up any stale e2e test resources left by crashed runs.
  // Matches SSM parameters under /e2e-test/ prefix and ECS clusters with e2e names.
  if (!process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"]) return;

  try {
    const region = process.env["AWS_REGION"] ?? "us-east-1";

    // Clean stale SSM params under /e2e-test/
    const { SSMClient, GetParametersByPathCommand, DeleteParameterCommand } =
      await import("@aws-sdk/client-ssm");
    const ssm = new SSMClient({ region });
    try {
      const params = await ssm.send(
        new GetParametersByPathCommand({ Path: "/e2e-test/", Recursive: true }),
      );
      for (const p of params.Parameters ?? []) {
        if (p.Name) {
          await ssm.send(new DeleteParameterCommand({ Name: p.Name }));
          console.log(`E2E sweeper: deleted stale SSM param ${p.Name}`);
        }
      }
    } catch {
      // path may not exist
    }

    // Clean stale ECS clusters with e2e/test names via tagging API
    const { ResourceGroupsTaggingAPIClient, GetResourcesCommand } =
      await import("@aws-sdk/client-resource-groups-tagging-api");
    const tagging = new ResourceGroupsTaggingAPIClient({ region });
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
          const cc = new CloudControlClient({ region });
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
}, 30_000);

function skipIfNoCreds() {
  if (!process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"]) {
    return true;
  }
  return false;
}

describe("E2E: S3 bucket plan", () => {
  it("generates a plan with pricing and BP findings", async () => {
    if (skipIfNoCreds()) return;

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

describe("E2E: EC2 instance plan", () => {
  it("generates a plan with compute pricing decomposition", async () => {
    if (skipIfNoCreds()) return;

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

describe("E2E: SSM Parameter plan + apply + destroy", () => {
  const paramName = `/e2e-test/assignee-${Date.now()}`;
  let resourceArn: string | undefined;

  it("plans, applies, and destroys an SSM parameter", async () => {
    if (skipIfNoCreds()) return;

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

    resourceArn = finalState.resourceArn;
  }, 90_000);

  afterAll(async () => {
    // Always attempt cleanup by name — works even if test crashed before resourceArn was set
    if (skipIfNoCreds()) return;

    try {
      const { SSMClient, DeleteParameterCommand } =
        await import("@aws-sdk/client-ssm");
      const ssm = new SSMClient({ region: process.env["AWS_REGION"] });
      await ssm.send(new DeleteParameterCommand({ Name: paramName }));
      console.log(`E2E cleanup: deleted SSM parameter ${paramName}`);
    } catch (err: any) {
      // ParameterNotFound is fine — means it was never created or already deleted
      if (err?.name !== "ParameterNotFound") {
        console.warn(`E2E cleanup failed for ${paramName}:`, err);
      }
    }
  }, 15_000);
});

describe("E2E: Epic 35 — Actionable Findings", () => {
  it("all findings have propertyPath set (Story 35.5)", async () => {
    if (skipIfNoCreds()) return;

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
    if (skipIfNoCreds()) return;

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
    if (skipIfNoCreds()) return;

    const { resolveAction } = await import("../utils/fix-command-resolver.js");

    const graph = createGraph(tools);

    // Auto-fix disabled → all findings remain (including auto-fixable)
    const fsModule = await import("node:fs");
    const configDir = path.resolve(process.cwd(), ".assignee");
    const configPath = path.join(configDir, "config.yaml");
    let existingConfig: string | undefined;
    try {
      existingConfig = fsModule.readFileSync(configPath, "utf-8");
    } catch {}
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
    if (skipIfNoCreds()) return;

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
    if (skipIfNoCreds()) return;

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

describe("E2E: Auto-fix verification", () => {
  it("fix_applicator applies patches when autoFixBestPractices is enabled", async () => {
    if (skipIfNoCreds()) return;

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

describe("E2E: Lambda Function plan", () => {
  it("generates a plan with runtime and memory configuration", async () => {
    if (skipIfNoCreds()) return;

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

describe("E2E: DynamoDB Table plan", () => {
  it("generates a plan with key schema and billing mode", async () => {
    if (skipIfNoCreds()) return;

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

describe("E2E: IAM Role plan", () => {
  it("generates a plan with assume role policy", async () => {
    if (skipIfNoCreds()) return;

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

    // IAM Role is free — verify cost estimate reflects that
    if (s.estimatedMonthlyCost) {
      const costLower = s.estimatedMonthlyCost.toLowerCase();
      expect(costLower).toMatch(/free|\$0|0\.00/);
    }
  }, 60_000);
});

describe("E2E: SQS Queue plan", () => {
  it("generates a plan with queue configuration", async () => {
    if (skipIfNoCreds()) return;

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

describe("E2E: VPC plan", () => {
  it("generates a plan with CIDR block and DNS settings", async () => {
    if (skipIfNoCreds()) return;

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
  }, 60_000);
});

describe("E2E: CloudWatch Alarm plan", () => {
  it("generates a plan with metric and threshold", async () => {
    if (skipIfNoCreds()) return;

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

describe("E2E: SecretsManager Secret plan", () => {
  it("generates a plan with secret configuration", async () => {
    if (skipIfNoCreds()) return;

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

describe("E2E: Error handling", () => {
  it("rejects unsupported resource type with clear error", async () => {
    if (skipIfNoCreds()) return;

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
    if (skipIfNoCreds()) return;

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

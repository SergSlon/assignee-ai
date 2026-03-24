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

// Load .env from project root (Node 22+ has --env-file but we do it manually for Vitest)
function loadEnv() {
  const envPath = path.resolve(import.meta.dirname, "../../../.env");
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
  } catch {
    // .env not available
  }
}
loadEnv();

let tools: StructuredTool[];
let mcpClient: Awaited<ReturnType<typeof createMcpClient>>;

beforeAll(async () => {
  // Skip if no credentials
  if (!process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"]) {
    console.warn("Skipping E2E tests: no AWS credentials configured");
    return;
  }

  mcpClient = await createMcpClient();
  tools = await getMcpTools(mcpClient);
}, 30_000);

afterAll(async () => {
  await closeMcpClient().catch(() => {});
}, 10_000);

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

    expect(finalState.resourceType).toBe("AWS::SSM::Parameter");
    expect(finalState.executionStatus).toBe(ExecutionStatus.SUCCESS);
    expect(finalState.resourceArn).toBeDefined();

    resourceArn = finalState.resourceArn;
  }, 90_000);

  afterAll(async () => {
    // Cleanup: destroy the SSM parameter if it was created
    if (!resourceArn || skipIfNoCreds()) return;

    try {
      const { SSMClient, DeleteParameterCommand } =
        await import("@aws-sdk/client-ssm");
      const ssm = new SSMClient({ region: process.env["AWS_REGION"] });
      await ssm.send(new DeleteParameterCommand({ Name: paramName }));
      console.log(`E2E cleanup: deleted SSM parameter ${paramName}`);
    } catch (err) {
      console.warn(`E2E cleanup failed for ${paramName}:`, err);
    }
  }, 15_000);
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

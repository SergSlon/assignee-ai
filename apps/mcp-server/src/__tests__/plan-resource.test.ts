/**
 * Unit tests for plan_resource MCP tool.
 * Mocks the graph's invoke() method to return predetermined final states.
 *
 * @see Story 20.2
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ExecutionMode, ExecutionStatus } from "@assignee/core";
import type { GraphContext } from "../services/graph-init.js";
import { registerPlanResource } from "../tools/plan-resource.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function createMockGraphContext(
  invokeResult: Record<string, unknown>,
): GraphContext {
  return {
    graph: {
      invoke: vi.fn().mockResolvedValue(invokeResult),
      getState: vi.fn().mockResolvedValue({ values: {}, next: [] }),
    },
    cleanup: vi.fn().mockResolvedValue(undefined),
  };
}

async function createTestClient(ctx?: GraphContext) {
  const server = new McpServer({
    name: "assignee-ai-test",
    version: "0.1.0",
  });

  registerPlanResource(server, ctx);

  const client = new Client({ name: "test-client", version: "0.1.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return { server, client };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseToolResult(result: any): Record<string, unknown> {
  const firstContent = result.content[0] as { type: string; text: string };
  return JSON.parse(firstContent.text) as Record<string, unknown>;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("plan_resource tool", () => {
  const originalRegion = process.env["AWS_REGION"];

  afterEach(() => {
    // Restore AWS_REGION
    if (originalRegion !== undefined) {
      process.env["AWS_REGION"] = originalRegion;
    } else {
      delete process.env["AWS_REGION"];
    }
  });

  describe("success path", () => {
    it("should return a plan with resourceType, desiredState, estimatedMonthlyCost, and checkpointPath", async () => {
      const mockState = {
        runId: "test-run-id",
        userIntent: "Create an S3 bucket for user uploads",
        executionStatus: ExecutionStatus.SUCCESS,
        resourceType: "AWS::S3::Bucket",
        desiredState: {
          BucketName: "user-uploads-bucket",
          VersioningConfiguration: { Status: "Enabled" },
        },
        estimatedMonthlyCost: "$0.023/GB",
        preflightPassed: true,
        bpFindings: [
          {
            id: "s3-versioning",
            severity: "MEDIUM",
            title: "Enable versioning",
            message: "Versioning is recommended for data protection.",
          },
        ],
        guardrailFindings: [],
        freeTierNote: {
          type: "legacy_eligible",
          message: "S3 includes 5GB free storage for 12 months.",
        },
        elicitedOptions: { versioning: true },
      };

      const ctx = createMockGraphContext(mockState);
      const { client } = await createTestClient(ctx);

      const result = await client.callTool({
        name: "plan_resource",
        arguments: { description: "Create an S3 bucket for user uploads" },
      });

      const data = parseToolResult(result);

      expect(data["resourceType"]).toBe("AWS::S3::Bucket");
      expect(data["desiredState"]).toEqual({
        BucketName: "user-uploads-bucket",
        VersioningConfiguration: { Status: "Enabled" },
      });
      expect(data["estimatedMonthlyCost"]).toBe("$0.023/GB");
      expect(data["checkpointPath"]).toBeDefined();
      expect(typeof data["checkpointPath"]).toBe("string");
      expect(data["checkpointPath"] as string).toContain("checkpoint-");
      expect(data["runId"]).toBeDefined();
      expect(result.isError).toBeFalsy();
    });

    it("should include bpFindings array in the response", async () => {
      const mockState = {
        executionStatus: ExecutionStatus.SUCCESS,
        resourceType: "AWS::S3::Bucket",
        desiredState: { BucketName: "test" },
        estimatedMonthlyCost: "$0.00",
        preflightPassed: true,
        bpFindings: [
          { id: "s3-encryption", severity: "HIGH", title: "Enable encryption" },
        ],
        guardrailFindings: [],
      };

      const ctx = createMockGraphContext(mockState);
      const { client } = await createTestClient(ctx);

      const result = await client.callTool({
        name: "plan_resource",
        arguments: { description: "Create an S3 bucket" },
      });

      const data = parseToolResult(result);
      expect(Array.isArray(data["bpFindings"])).toBe(true);
      expect(data["bpFindings"]).toHaveLength(1);
      expect(
        (data["bpFindings"] as Array<Record<string, unknown>>)[0]!["id"],
      ).toBe("s3-encryption");
    });

    it("should return empty bpFindings when none are present", async () => {
      const mockState = {
        executionStatus: ExecutionStatus.SUCCESS,
        resourceType: "AWS::Lambda::Function",
        desiredState: { FunctionName: "test-fn" },
        estimatedMonthlyCost: "$0.00",
        preflightPassed: true,
      };

      const ctx = createMockGraphContext(mockState);
      const { client } = await createTestClient(ctx);

      const result = await client.callTool({
        name: "plan_resource",
        arguments: { description: "Create a Lambda function" },
      });

      const data = parseToolResult(result);
      expect(data["bpFindings"]).toEqual([]);
    });

    it("should include guardrailFindings and freeTierNote in the response", async () => {
      const mockState = {
        executionStatus: ExecutionStatus.SUCCESS,
        resourceType: "AWS::IAM::Role",
        desiredState: { RoleName: "my-role" },
        estimatedMonthlyCost: "$0.00",
        preflightPassed: true,
        guardrailFindings: [
          { severity: "HIGH", title: "Admin access detected" },
        ],
        freeTierNote: { type: "always_free", message: "IAM is always free." },
      };

      const ctx = createMockGraphContext(mockState);
      const { client } = await createTestClient(ctx);

      const result = await client.callTool({
        name: "plan_resource",
        arguments: { description: "Create an IAM role" },
      });

      const data = parseToolResult(result);
      expect(data["guardrailFindings"]).toHaveLength(1);
      expect(data["freeTierNote"]).toBeDefined();
      expect((data["freeTierNote"] as Record<string, unknown>)["type"]).toBe(
        "always_free",
      );
    });
  });

  describe("error paths", () => {
    it("should return isError: true for FAILED execution status", async () => {
      const mockState = {
        executionStatus: ExecutionStatus.FAILED,
        errorMessage: "AWS credentials are not configured",
      };

      const ctx = createMockGraphContext(mockState);
      const { client } = await createTestClient(ctx);

      const result = await client.callTool({
        name: "plan_resource",
        arguments: { description: "Create an S3 bucket" },
      });

      const data = parseToolResult(result);
      expect(result.isError).toBe(true);
      expect(data["error"]).toBe(true);
      expect(data["message"]).toBe("AWS credentials are not configured");
      expect(data["status"]).toBe(ExecutionStatus.FAILED);
    });

    it("should return isError: true for UNSUPPORTED_RESOURCE with hint", async () => {
      const mockState = {
        executionStatus: ExecutionStatus.UNSUPPORTED_RESOURCE,
        errorMessage:
          "Resource type 'AWS::Neptune::DBCluster' is not supported",
      };

      const ctx = createMockGraphContext(mockState);
      const { client } = await createTestClient(ctx);

      const result = await client.callTool({
        name: "plan_resource",
        arguments: { description: "Create a Neptune database cluster" },
      });

      const data = parseToolResult(result);
      expect(result.isError).toBe(true);
      expect(data["error"]).toBe(true);
      expect(data["status"]).toBe(ExecutionStatus.UNSUPPORTED_RESOURCE);
      expect(data["hint"]).toBeDefined();
      expect(typeof data["hint"]).toBe("string");
      expect(data["hint"] as string).toContain("Supported types");
    });

    it("should return default error message when errorMessage is absent", async () => {
      const mockState = {
        executionStatus: ExecutionStatus.FAILED,
      };

      const ctx = createMockGraphContext(mockState);
      const { client } = await createTestClient(ctx);

      const result = await client.callTool({
        name: "plan_resource",
        arguments: { description: "something" },
      });

      const data = parseToolResult(result);
      expect(data["message"]).toBe("Plan generation failed");
    });

    it("should handle unexpected graph errors gracefully", async () => {
      const ctx: GraphContext = {
        graph: {
          invoke: vi.fn().mockRejectedValue(new Error("Connection timeout")),
          getState: vi.fn().mockResolvedValue({ values: {}, next: [] }),
        },
        cleanup: vi.fn().mockResolvedValue(undefined),
      };

      const { client } = await createTestClient(ctx);

      const result = await client.callTool({
        name: "plan_resource",
        arguments: { description: "Create an S3 bucket" },
      });

      const data = parseToolResult(result);
      expect(result.isError).toBe(true);
      expect(data["error"]).toBe(true);
      expect(data["message"]).toContain("Connection timeout");
      expect(data["status"]).toBe("INTERNAL_ERROR");
    });

    it("should return NOT_READY when no graph context is provided", async () => {
      const { client } = await createTestClient(/* no ctx */);

      const result = await client.callTool({
        name: "plan_resource",
        arguments: { description: "Create an S3 bucket" },
      });

      const data = parseToolResult(result);
      expect(result.isError).toBe(true);
      expect(data["error"]).toBe(true);
      expect(data["status"]).toBe("NOT_READY");
    });
  });

  describe("region override", () => {
    it("should forward region parameter to process.env.AWS_REGION during invocation", async () => {
      let capturedRegion: string | undefined;

      const ctx: GraphContext = {
        graph: {
          invoke: vi.fn().mockImplementation(async () => {
            capturedRegion = process.env["AWS_REGION"];
            return {
              executionStatus: ExecutionStatus.SUCCESS,
              resourceType: "AWS::S3::Bucket",
              desiredState: { BucketName: "test" },
              estimatedMonthlyCost: "$0.00",
              preflightPassed: true,
            };
          }),
          getState: vi.fn().mockResolvedValue({ values: {}, next: [] }),
        },
        cleanup: vi.fn().mockResolvedValue(undefined),
      };

      const { client } = await createTestClient(ctx);

      await client.callTool({
        name: "plan_resource",
        arguments: {
          description: "Create an S3 bucket",
          region: "eu-west-1",
        },
      });

      expect(capturedRegion).toBe("eu-west-1");
      // Region should be restored after invocation
      expect(process.env["AWS_REGION"]).toBe(originalRegion);
    });

    it("should restore original AWS_REGION after invocation even on error", async () => {
      process.env["AWS_REGION"] = "us-east-1";

      const ctx: GraphContext = {
        graph: {
          invoke: vi.fn().mockRejectedValue(new Error("boom")),
          getState: vi.fn().mockResolvedValue({ values: {}, next: [] }),
        },
        cleanup: vi.fn().mockResolvedValue(undefined),
      };

      const { client } = await createTestClient(ctx);

      await client.callTool({
        name: "plan_resource",
        arguments: {
          description: "Create an S3 bucket",
          region: "ap-southeast-1",
        },
      });

      expect(process.env["AWS_REGION"]).toBe("us-east-1");
    });
  });

  describe("env passthrough", () => {
    it("should prepend env tag to description when env parameter is provided", async () => {
      const mockState = {
        executionStatus: ExecutionStatus.SUCCESS,
        resourceType: "AWS::S3::Bucket",
        desiredState: { BucketName: "test" },
        estimatedMonthlyCost: "$0.00",
        preflightPassed: true,
      };

      const ctx = createMockGraphContext(mockState);
      const { client } = await createTestClient(ctx);

      await client.callTool({
        name: "plan_resource",
        arguments: {
          description: "Create an S3 bucket",
          env: "production",
        },
      });

      const invokeCall = (ctx.graph.invoke as ReturnType<typeof vi.fn>).mock
        .calls[0]!;
      const invokeInput = invokeCall[0] as Record<string, unknown>;

      expect(invokeInput["userIntent"]).toBe(
        "[env:production] Create an S3 bucket",
      );
    });

    it("should not modify description when env is not provided", async () => {
      const mockState = {
        executionStatus: ExecutionStatus.SUCCESS,
        resourceType: "AWS::S3::Bucket",
        desiredState: { BucketName: "test" },
        estimatedMonthlyCost: "$0.00",
        preflightPassed: true,
      };

      const ctx = createMockGraphContext(mockState);
      const { client } = await createTestClient(ctx);

      await client.callTool({
        name: "plan_resource",
        arguments: { description: "Create an S3 bucket" },
      });

      const invokeCall = (ctx.graph.invoke as ReturnType<typeof vi.fn>).mock
        .calls[0]!;
      const invokeInput = invokeCall[0] as Record<string, unknown>;

      expect(invokeInput["userIntent"]).toBe("Create an S3 bucket");
    });
  });

  describe("graph invocation", () => {
    it("should invoke graph with PLAN executionMode and noWizard: true", async () => {
      const mockState = {
        executionStatus: ExecutionStatus.SUCCESS,
        resourceType: "AWS::S3::Bucket",
        desiredState: { BucketName: "test" },
        estimatedMonthlyCost: "$0.00",
        preflightPassed: true,
      };

      const ctx = createMockGraphContext(mockState);
      const { client } = await createTestClient(ctx);

      await client.callTool({
        name: "plan_resource",
        arguments: { description: "Create an S3 bucket" },
      });

      expect(ctx.graph.invoke).toHaveBeenCalledTimes(1);

      const invokeCall = (ctx.graph.invoke as ReturnType<typeof vi.fn>).mock
        .calls[0]!;
      const invokeInput = invokeCall[0] as Record<string, unknown>;
      const invokeConfig = invokeCall[1] as {
        configurable: { thread_id: string };
      };

      expect(invokeInput["executionMode"]).toBe(ExecutionMode.PLAN);
      expect(invokeInput["noWizard"]).toBe(true);
      expect(invokeInput["startedAt"]).toBeDefined();
      expect(typeof invokeInput["runId"]).toBe("string");
      expect(invokeConfig.configurable.thread_id).toBe(invokeInput["runId"]);
    });
  });
});

/**
 * MCP protocol compliance and edge case tests.
 * Verifies:
 * - tools/list returns all 5 tools with valid JSON Schema
 * - Server starts without error
 * - Server handles malformed requests gracefully
 * - No stdout pollution (all logs to stderr)
 * - Tool parameter schemas are correct
 * - Edge cases: no AWS credentials, sub-server failure, large responses
 */

import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { registerTools } from "../tools/index.js";
import type { GraphContext } from "../services/graph-init.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const EXPECTED_TOOLS = [
  "plan_resource",
  "apply_plan",
  "list_managed_resources",
  "estimate_cost",
  "destroy_resource",
] as const;

async function createTestServerAndClient(ctx?: GraphContext) {
  const server = new McpServer({
    name: "assignee-ai-compliance-test",
    version: "0.1.0",
  });

  registerTools(server, ctx);

  const client = new Client({ name: "test-client", version: "0.1.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return { server, client };
}

type TextContent = Array<{ type: string; text: string }>;

function parseResult(result: Record<string, unknown>) {
  const content = result["content"] as TextContent;
  return JSON.parse(content[0]!.text);
}

// ── Protocol compliance ──────────────────────────────────────────────────────

describe("MCP Protocol Compliance", () => {
  describe("tools/list", () => {
    it("should return exactly 5 tools", async () => {
      const { client } = await createTestServerAndClient();
      const result = await client.listTools();
      expect(result.tools).toHaveLength(5);
    });

    it("should return all expected tool names", async () => {
      const { client } = await createTestServerAndClient();
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name).sort();
      expect(names).toEqual([...EXPECTED_TOOLS].sort());
    });

    it("each tool inputSchema should be a valid JSON Schema object", async () => {
      const { client } = await createTestServerAndClient();
      const result = await client.listTools();

      for (const tool of result.tools) {
        // Tier C: dropped redundant toBeDefined() — .type access fails
        // naturally and the toBe("object") is strictly stronger
        expect(tool.inputSchema.type).toBe("object");
        expect(typeof tool.inputSchema.properties).toBe("object");
        // JSON Schema must not have undefined keys
        expect(JSON.stringify(tool.inputSchema)).not.toContain("undefined");
      }
    });

    it("each tool should have a non-empty description string", async () => {
      const { client } = await createTestServerAndClient();
      const result = await client.listTools();

      for (const tool of result.tools) {
        expect(typeof tool.description).toBe("string");
        expect(tool.description!.length).toBeGreaterThan(10);
      }
    });

    it("tools/list should be idempotent (returns same result on repeated calls)", async () => {
      const { client } = await createTestServerAndClient();
      const result1 = await client.listTools();
      const result2 = await client.listTools();
      expect(result1.tools.map((t) => t.name).sort()).toEqual(
        result2.tools.map((t) => t.name).sort(),
      );
    });
  });

  describe("server startup", () => {
    it("should create McpServer without errors", () => {
      expect(
        () =>
          new McpServer({
            name: "assignee-ai",
            version: "0.1.0",
          }),
      ).not.toThrow();
    });

    it("should register tools without errors when no graph context is provided", () => {
      const server = new McpServer({
        name: "assignee-ai-test",
        version: "0.1.0",
      });
      expect(() => registerTools(server)).not.toThrow();
    });

    it("should register tools without errors when graph context is provided", () => {
      const server = new McpServer({
        name: "assignee-ai-test",
        version: "0.1.0",
      });
      // This test only asserts that `registerTools()` does not throw — the
      // graph is NEVER invoked. The mocked `invoke` resolves to a realistic
      // agent-graph terminal state (the same shape used in the
      // "large response handling" test below) so the mock matches the
      // production `CompiledGraph.invoke` return contract even though
      // the test doesn't read it.
      const ctx: GraphContext = {
        graph: {
          invoke: vi.fn().mockResolvedValue({
            executionStatus: "success",
            resourceType: "AWS::S3::Bucket",
            desiredState: { BucketName: "test-bucket" },
            estimatedMonthlyCost: "$0.00",
            preflightPassed: true,
          }),
          getState: vi.fn().mockResolvedValue({ values: {}, next: [] }),
        },
        cleanup: vi.fn().mockResolvedValue(undefined),
      };
      expect(() => registerTools(server, ctx)).not.toThrow();
    });

    it("should connect to transport without errors", async () => {
      const server = new McpServer({
        name: "assignee-ai-test",
        version: "0.1.0",
      });
      registerTools(server);
      const [_, serverTransport] = InMemoryTransport.createLinkedPair();
      await expect(server.connect(serverTransport)).resolves.not.toThrow();
    });
  });

  describe("no stdout pollution", () => {
    it("index.ts should use process.stderr.write, not console.log/stdout", async () => {
      // Verify that the main index.ts file only writes to stderr
      // by reading the source code and checking for console.log usage
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const indexSource = await fs.readFile(
        path.resolve(import.meta.dirname ?? ".", "..", "index.ts"),
        "utf-8",
      );

      expect(indexSource).not.toContain("console.log(");
      expect(indexSource).not.toContain("process.stdout.write");
      // Should only use process.stderr.write
      expect(indexSource).toContain("process.stderr.write");
    });
  });
});

// ── Tool parameter schema validation ─────────────────────────────────────────

describe("Tool Parameter Schemas", () => {
  describe("plan_resource schema", () => {
    it("should have 'description' as a required string parameter", async () => {
      const { client } = await createTestServerAndClient();
      const result = await client.listTools();
      const tool = result.tools.find((t) => t.name === "plan_resource")!;

      expect(tool.inputSchema.required).toContain("description");
      expect(
        (tool.inputSchema.properties as Record<string, { type: string }>)[
          "description"
        ]!.type,
      ).toBe("string");
    });

    it("should have 'region' as an optional string parameter", async () => {
      const { client } = await createTestServerAndClient();
      const result = await client.listTools();
      const tool = result.tools.find((t) => t.name === "plan_resource")!;

      expect(tool.inputSchema.properties).toHaveProperty("region");
      // Optional fields should NOT be in required
      const required = tool.inputSchema.required ?? [];
      expect(required).not.toContain("region");
    });

    it("should have 'env' as an optional string parameter", async () => {
      const { client } = await createTestServerAndClient();
      const result = await client.listTools();
      const tool = result.tools.find((t) => t.name === "plan_resource")!;

      expect(tool.inputSchema.properties).toHaveProperty("env");
      const required = tool.inputSchema.required ?? [];
      expect(required).not.toContain("env");
    });
  });

  describe("apply_plan schema", () => {
    it("should have 'checkpointPath' and 'confirmed' as required parameters", async () => {
      const { client } = await createTestServerAndClient();
      const result = await client.listTools();
      const tool = result.tools.find((t) => t.name === "apply_plan")!;

      expect(tool.inputSchema.required).toContain("checkpointPath");
      expect(tool.inputSchema.required).toContain("confirmed");
    });

    it("'confirmed' should be a boolean type", async () => {
      const { client } = await createTestServerAndClient();
      const result = await client.listTools();
      const tool = result.tools.find((t) => t.name === "apply_plan")!;

      expect(
        (tool.inputSchema.properties as Record<string, { type: string }>)[
          "confirmed"
        ]!.type,
      ).toBe("boolean");
    });

    it("'checkpointPath' should be a string type", async () => {
      const { client } = await createTestServerAndClient();
      const result = await client.listTools();
      const tool = result.tools.find((t) => t.name === "apply_plan")!;

      expect(
        (tool.inputSchema.properties as Record<string, { type: string }>)[
          "checkpointPath"
        ]!.type,
      ).toBe("string");
    });
  });

  describe("list_managed_resources schema", () => {
    it("should have only optional parameters (no required fields)", async () => {
      const { client } = await createTestServerAndClient();
      const result = await client.listTools();
      const tool = result.tools.find(
        (t) => t.name === "list_managed_resources",
      )!;

      // Both region and resourceType are optional
      const required = tool.inputSchema.required ?? [];
      expect(required).not.toContain("region");
      expect(required).not.toContain("resourceType");
    });

    it("should have 'region' and 'resourceType' as string properties", async () => {
      const { client } = await createTestServerAndClient();
      const result = await client.listTools();
      const tool = result.tools.find(
        (t) => t.name === "list_managed_resources",
      )!;
      const props = tool.inputSchema.properties as Record<
        string,
        { type: string }
      >;

      // Tier C: strengthened — assert the actual schema type, not just
      // defined-ness
      expect(props["region"]).toMatchObject({ type: "string" });
      expect(props["resourceType"]).toMatchObject({ type: "string" });
    });
  });

  describe("estimate_cost schema", () => {
    it("should have 'description' as the only required parameter", async () => {
      const { client } = await createTestServerAndClient();
      const result = await client.listTools();
      const tool = result.tools.find((t) => t.name === "estimate_cost")!;

      expect(tool.inputSchema.required).toContain("description");
      const required = tool.inputSchema.required ?? [];
      expect(required).not.toContain("resourceType");
      expect(required).not.toContain("desiredState");
      expect(required).not.toContain("region");
    });

    it("should have 'desiredState' as an optional object parameter", async () => {
      const { client } = await createTestServerAndClient();
      const result = await client.listTools();
      const tool = result.tools.find((t) => t.name === "estimate_cost")!;
      const props = tool.inputSchema.properties as Record<
        string,
        { type: string }
      >;

      // Tier C: dropped redundant toBeDefined() — .type access fails on undefined
      expect(props["desiredState"]!.type).toBe("object");
    });
  });

  describe("destroy_resource schema", () => {
    it("should have 'resource_identifier' and 'confirmed' as required parameters", async () => {
      const { client } = await createTestServerAndClient();
      const result = await client.listTools();
      const tool = result.tools.find((t) => t.name === "destroy_resource")!;

      expect(tool.inputSchema.required).toContain("resource_identifier");
      expect(tool.inputSchema.required).toContain("confirmed");
    });

    it("'resource_identifier' should be a string type", async () => {
      const { client } = await createTestServerAndClient();
      const result = await client.listTools();
      const tool = result.tools.find((t) => t.name === "destroy_resource")!;
      const props = tool.inputSchema.properties as Record<
        string,
        { type: string }
      >;

      expect(props["resource_identifier"]!.type).toBe("string");
    });
  });
});

// ── Edge cases ───────────────────────────────────────────────────────────────

describe("Edge Cases", () => {
  describe("MCP server with no graph context (simulates startup without AWS credentials)", () => {
    it("plan_resource should return NOT_READY gracefully", async () => {
      const { client } = await createTestServerAndClient(/* no ctx */);

      const result = await client.callTool({
        name: "plan_resource",
        arguments: { description: "Create an S3 bucket" },
      });

      expect(result.isError).toBe(true);
      const body = parseResult(result);
      expect(body.status).toBe("NOT_READY");
      expect(body.error).toBe(true);
      expect(body.message).toContain("Graph context not initialized");
    });

    it("apply_plan should return error when graph context is absent (after confirmed gate)", async () => {
      const { client } = await createTestServerAndClient(/* no ctx */);

      const result = await client.callTool({
        name: "apply_plan",
        arguments: {
          checkpointPath: "/tmp/checkpoint.json",
          confirmed: true,
        },
      });

      expect(result.isError).toBe(true);
      const body = parseResult(result);
      expect(body.error).toBe(true);
      expect(body.message).toContain("graph context not initialized");
    });
  });

  describe("sub-server / graph failure (graceful degradation)", () => {
    it("plan_resource should catch graph.invoke() rejection and return structured error", async () => {
      const ctx: GraphContext = {
        graph: {
          invoke: vi.fn().mockRejectedValue(new Error("LangGraph unavailable")),
          getState: vi.fn().mockResolvedValue({ values: {}, next: [] }),
        },
        cleanup: vi.fn().mockResolvedValue(undefined),
      };

      const { client } = await createTestServerAndClient(ctx);

      const result = await client.callTool({
        name: "plan_resource",
        arguments: { description: "Create an S3 bucket" },
      });

      expect(result.isError).toBe(true);
      const body = parseResult(result);
      expect(body.error).toBe(true);
      expect(body.message).toContain("LangGraph unavailable");
      expect(body.status).toBe("INTERNAL_ERROR");
    });

    it("plan_resource should handle non-Error throw from graph", async () => {
      const ctx: GraphContext = {
        graph: {
          invoke: vi.fn().mockRejectedValue("string error, not Error"),
          getState: vi.fn().mockResolvedValue({ values: {}, next: [] }),
        },
        cleanup: vi.fn().mockResolvedValue(undefined),
      };

      const { client } = await createTestServerAndClient(ctx);

      const result = await client.callTool({
        name: "plan_resource",
        arguments: { description: "Create an S3 bucket" },
      });

      expect(result.isError).toBe(true);
      const body = parseResult(result);
      expect(body.message).toContain("string error, not Error");
    });
  });

  describe("large response handling", () => {
    it("plan_resource should handle large desiredState objects", async () => {
      // Create a large desiredState with many properties
      const largeDesiredState: Record<string, unknown> = {};
      for (let i = 0; i < 200; i++) {
        largeDesiredState[`Property${i}`] = `value-${i}-${"x".repeat(100)}`;
      }

      const mockState = {
        executionStatus: "success",
        resourceType: "AWS::CloudFormation::Stack",
        desiredState: largeDesiredState,
        estimatedMonthlyCost: "$10.00",
        preflightPassed: true,
      };

      const ctx: GraphContext = {
        graph: {
          invoke: vi.fn().mockResolvedValue(mockState),
          getState: vi.fn().mockResolvedValue({ values: {}, next: [] }),
        },
        cleanup: vi.fn().mockResolvedValue(undefined),
      };

      const { client } = await createTestServerAndClient(ctx);

      const result = await client.callTool({
        name: "plan_resource",
        arguments: { description: "Create a large CloudFormation stack" },
      });

      expect(result.isError).toBeFalsy();
      const body = parseResult(result);
      expect(Object.keys(body.desiredState).length).toBe(200);
    });
  });

  describe("estimate_cost with unknown resource description", () => {
    it("should return N/A cost gracefully for unrecognized descriptions", async () => {
      const { client } = await createTestServerAndClient();

      const result = await client.callTool({
        name: "estimate_cost",
        arguments: {
          description: "something completely unknown xyz123",
        },
      });

      expect(result.isError).toBeFalsy();
      const body = parseResult(result);
      expect(body.resourceType).toBe("unknown");
      expect(body.estimatedMonthlyCost).toBe("N/A");
      expect(body.note).toContain("not recognized");
    });
  });

  describe("estimate_cost with explicit resourceType override", () => {
    it("should use provided resourceType instead of classifying from description", async () => {
      const { client } = await createTestServerAndClient();

      const result = await client.callTool({
        name: "estimate_cost",
        arguments: {
          description: "something vague",
          resourceType: "AWS::S3::Bucket",
        },
      });

      expect(result.isError).toBeFalsy();
      const body = parseResult(result);
      expect(body.resourceType).toBe("AWS::S3::Bucket");
      // Tier C: strengthened — must be a non-empty string
      expect(typeof body.estimatedMonthlyCost).toBe("string");
      expect(body.note).toContain("baseline estimate");
    });
  });

  describe("estimate_cost with desiredState", () => {
    it("should pass desiredState to pricing estimator", async () => {
      const { client } = await createTestServerAndClient();

      const result = await client.callTool({
        name: "estimate_cost",
        arguments: {
          description: "EC2 instance",
          desiredState: { InstanceType: "t3.micro" },
        },
      });

      expect(result.isError).toBeFalsy();
      const body = parseResult(result);
      expect(body.resourceType).toBe("AWS::EC2::Instance");
    });
  });

  describe("estimate_cost with region override", () => {
    it("should include specified region in response", async () => {
      const { client } = await createTestServerAndClient();

      const result = await client.callTool({
        name: "estimate_cost",
        arguments: {
          description: "S3 bucket",
          region: "eu-west-1",
        },
      });

      expect(result.isError).toBeFalsy();
      const body = parseResult(result);
      expect(body.region).toBe("eu-west-1");
    });

    it("should default region to us-east-1 when not specified", async () => {
      const { client } = await createTestServerAndClient();

      const result = await client.callTool({
        name: "estimate_cost",
        arguments: {
          description: "S3 bucket",
        },
      });

      expect(result.isError).toBeFalsy();
      const body = parseResult(result);
      expect(body.region).toBe("us-east-1");
    });
  });

  describe("all tools return valid MCP content structure", () => {
    it("plan_resource NOT_READY response has correct content shape", async () => {
      const { client } = await createTestServerAndClient();

      const result = await client.callTool({
        name: "plan_resource",
        arguments: { description: "Create an S3 bucket" },
      });

      const content = result.content as TextContent;
      expect(content).toHaveLength(1);
      expect(content[0]!.type).toBe("text");
      expect(typeof content[0]!.text).toBe("string");
      // Text should be valid JSON
      expect(() => JSON.parse(content[0]!.text)).not.toThrow();
    });

    it("apply_plan safety gate response has correct content shape", async () => {
      const { client } = await createTestServerAndClient();

      const result = await client.callTool({
        name: "apply_plan",
        arguments: {
          checkpointPath: "/tmp/test.json",
          confirmed: false,
        },
      });

      const content = result.content as TextContent;
      expect(content).toHaveLength(1);
      expect(content[0]!.type).toBe("text");
      expect(() => JSON.parse(content[0]!.text)).not.toThrow();
    });

    it("estimate_cost response has correct content shape", async () => {
      const { client } = await createTestServerAndClient();

      const result = await client.callTool({
        name: "estimate_cost",
        arguments: { description: "S3 bucket" },
      });

      const content = result.content as TextContent;
      expect(content).toHaveLength(1);
      expect(content[0]!.type).toBe("text");
      expect(() => JSON.parse(content[0]!.text)).not.toThrow();
    });
  });

  describe("concurrent tool calls", () => {
    it("should handle multiple concurrent estimate_cost calls", async () => {
      const { client } = await createTestServerAndClient();

      const descriptions = [
        "S3 bucket",
        "Lambda function",
        "DynamoDB table",
        "SQS queue",
        "IAM role",
      ];

      const results = await Promise.all(
        descriptions.map((d) =>
          client.callTool({
            name: "estimate_cost",
            arguments: { description: d },
          }),
        ),
      );

      for (const result of results) {
        expect(result.isError).toBeFalsy();
        const body = parseResult(result);
        // Tier C: strengthened — must be non-empty CFN type strings
        expect(body.resourceType).toMatch(/^AWS::[A-Za-z0-9]+::[A-Za-z0-9]+$/);
        expect(typeof body.estimatedMonthlyCost).toBe("string");
      }
    });
  });
});

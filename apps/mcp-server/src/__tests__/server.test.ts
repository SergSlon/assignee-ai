/**
 * Unit tests for MCP server tool registration.
 * Verifies all 4 tools are registered with correct names and input schemas.
 */

import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { registerTools } from "../tools/index.js";

const EXPECTED_TOOLS = [
  "plan_resource",
  "apply_plan",
  "list_managed_resources",
  "estimate_cost",
] as const;

async function createTestServerAndClient() {
  const server = new McpServer({
    name: "assignee-ai-test",
    version: "0.1.0",
  });

  registerTools(server);

  const client = new Client({ name: "test-client", version: "0.1.0" });

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return { server, client };
}

describe("MCP Server", () => {
  it("should instantiate without error", () => {
    const server = new McpServer({
      name: "assignee-ai-test",
      version: "0.1.0",
    });
    expect(server).toBeDefined();
  });

  it("should register all 4 tools", async () => {
    const { client } = await createTestServerAndClient();

    const result = await client.listTools();
    const toolNames = result.tools.map((t) => t.name).sort();

    expect(toolNames).toEqual([...EXPECTED_TOOLS].sort());
  });

  it("tools/list should return exactly 4 tools", async () => {
    const { client } = await createTestServerAndClient();

    const result = await client.listTools();
    expect(result.tools).toHaveLength(4);
  });

  it("each tool should have a valid inputSchema with type 'object'", async () => {
    const { client } = await createTestServerAndClient();

    const result = await client.listTools();

    for (const tool of result.tools) {
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe("object");
      expect(typeof tool.inputSchema.properties).toBe("object");
    }
  });

  it("each tool should have a description", async () => {
    const { client } = await createTestServerAndClient();

    const result = await client.listTools();

    for (const tool of result.tools) {
      expect(tool.description).toBeDefined();
      expect(typeof tool.description).toBe("string");
      expect(tool.description!.length).toBeGreaterThan(0);
    }
  });

  describe("plan_resource tool", () => {
    it("should have 'description' as a required parameter", async () => {
      const { client } = await createTestServerAndClient();

      const result = await client.listTools();
      const tool = result.tools.find((t) => t.name === "plan_resource");

      expect(tool).toBeDefined();
      expect(tool!.inputSchema.properties).toHaveProperty("description");
      expect(tool!.inputSchema.required).toContain("description");
    });

    it("should have optional 'region' and 'env' parameters", async () => {
      const { client } = await createTestServerAndClient();

      const result = await client.listTools();
      const tool = result.tools.find((t) => t.name === "plan_resource");

      expect(tool!.inputSchema.properties).toHaveProperty("region");
      expect(tool!.inputSchema.properties).toHaveProperty("env");
    });

    it("should return not-ready error when graph context is absent", async () => {
      const { client } = await createTestServerAndClient();

      const result = await client.callTool({
        name: "plan_resource",
        arguments: { description: "Create an S3 bucket" },
      });

      expect(result.isError).toBe(true);
      const body = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0]!.text,
      );
      expect(body.status).toBe("NOT_READY");
    });
  });

  describe("apply_plan tool", () => {
    it("should have 'checkpointPath' and 'confirmed' as required parameters", async () => {
      const { client } = await createTestServerAndClient();

      const result = await client.listTools();
      const tool = result.tools.find((t) => t.name === "apply_plan");

      expect(tool).toBeDefined();
      expect(tool!.inputSchema.required).toContain("checkpointPath");
      expect(tool!.inputSchema.required).toContain("confirmed");
    });

    it("should reject unconfirmed apply with safety error", async () => {
      const { client } = await createTestServerAndClient();

      const result = await client.callTool({
        name: "apply_plan",
        arguments: {
          checkpointPath: "/tmp/checkpoint.json",
          confirmed: false,
        },
      });

      expect(result.isError).toBe(true);
      const body = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0]!.text,
      );
      expect(body.message).toContain("explicit confirmation");
    });
  });

  describe("list_managed_resources tool", () => {
    it("should have optional 'region' and 'resourceType' parameters", async () => {
      const { client } = await createTestServerAndClient();

      const result = await client.listTools();
      const tool = result.tools.find(
        (t) => t.name === "list_managed_resources",
      );

      expect(tool).toBeDefined();
      expect(tool!.inputSchema.properties).toHaveProperty("region");
      expect(tool!.inputSchema.properties).toHaveProperty("resourceType");
    });
  });

  describe("estimate_cost tool", () => {
    it("should have 'description' as a required parameter", async () => {
      const { client } = await createTestServerAndClient();

      const result = await client.listTools();
      const tool = result.tools.find((t) => t.name === "estimate_cost");

      expect(tool).toBeDefined();
      expect(tool!.inputSchema.required).toContain("description");
    });
  });
});

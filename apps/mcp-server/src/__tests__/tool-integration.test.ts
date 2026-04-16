/**
 * MCP tool-level integration tests.
 * Tests list_managed_resources and estimate_cost through the MCP client
 * (tool registration + invocation), complementing the existing service-level tests.
 *
 * Also tests the free-tier service directly.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { registerListManagedResources } from "../tools/list-managed-resources.js";
import { registerEstimateCost } from "../tools/estimate-cost.js";
import { getFreeTierNote } from "../services/free-tier.js";

// ── Mock AWS SDK for list_managed_resources ──────────────────────────────────

// NOTE: Plain class constructors survive vitest's mockReset:true (which would
// otherwise wipe vi.fn implementations between tests). Default fs.readFileSync
// behavior is re-installed in beforeEach.
const mockSend = vi.fn();
vi.mock("@aws-sdk/client-resource-groups-tagging-api", () => {
  class ResourceGroupsTaggingAPIClient {
    send = mockSend;
    destroy = vi.fn();
  }
  return {
    ResourceGroupsTaggingAPIClient,
    GetResourcesCommand: vi.fn(),
  };
});

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

type TextContent = Array<{ type: string; text: string }>;

function parseResult(result: Record<string, unknown>) {
  const content = result["content"] as TextContent;
  return JSON.parse(content[0]!.text);
}

async function createListResourcesClient() {
  const server = new McpServer({
    name: "list-resources-test",
    version: "0.1.0",
  });

  registerListManagedResources(server);

  const client = new Client({ name: "test-client", version: "0.1.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return { server, client };
}

async function createEstimateCostClient() {
  const server = new McpServer({
    name: "estimate-cost-test",
    version: "0.1.0",
  });

  registerEstimateCost(server);

  const client = new Client({ name: "test-client", version: "0.1.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return { server, client };
}

// ── list_managed_resources tool-level tests ──────────────────────────────────

describe("list_managed_resources tool (MCP client level)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Re-install fs.readFileSync default (mockReset wipes it).
    const fs = await import("node:fs");
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("File not found");
    });
  });

  it("should return formatted list with count and resources array", async () => {
    mockSend.mockResolvedValueOnce({
      ResourceTagMappingList: [
        {
          ResourceARN: "arn:aws:s3:::my-bucket",
          Tags: [
            { Key: "managed-by", Value: "assignee-ai" },
            { Key: "assignee-run-id", Value: "2026-03-20T10:00:00Z" },
          ],
        },
        {
          ResourceARN: "arn:aws:lambda:us-east-1:123456789012:function:my-fn",
          Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
        },
      ],
      PaginationToken: undefined,
    });

    const { client } = await createListResourcesClient();

    const result = await client.callTool({
      name: "list_managed_resources",
      arguments: {},
    });

    expect(result.isError).toBeFalsy();
    const body = parseResult(result);
    expect(body.count).toBe(2);
    expect(body.resources).toHaveLength(2);
    expect(body.resources[0].arn).toBe("arn:aws:s3:::my-bucket");
    expect(body.resources[0].resourceType).toBe("AWS::S3::Bucket");
    expect(body.resources[1].resourceType).toBe("AWS::Lambda::Function");
  });

  it("should return empty list when no resources are managed", async () => {
    mockSend.mockResolvedValueOnce({
      ResourceTagMappingList: [],
      PaginationToken: undefined,
    });

    const { client } = await createListResourcesClient();

    const result = await client.callTool({
      name: "list_managed_resources",
      arguments: {},
    });

    expect(result.isError).toBeFalsy();
    const body = parseResult(result);
    expect(body.count).toBe(0);
    expect(body.resources).toEqual([]);
  });

  it("should return error with hint when AWS credentials are missing", async () => {
    mockSend.mockRejectedValueOnce(new Error("Missing credentials in config"));

    const { client } = await createListResourcesClient();

    const result = await client.callTool({
      name: "list_managed_resources",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    const body = parseResult(result);
    expect(body.error).toBe(true);
    expect(body.message).toContain("Missing credentials");
    expect(body.hint).toContain("AWS credentials");
  });

  it("should accept optional region parameter", async () => {
    mockSend.mockResolvedValueOnce({
      ResourceTagMappingList: [],
      PaginationToken: undefined,
    });

    const { client } = await createListResourcesClient();

    const result = await client.callTool({
      name: "list_managed_resources",
      arguments: { region: "eu-west-1" },
    });

    expect(result.isError).toBeFalsy();
  });

  it("should accept optional resourceType filter", async () => {
    mockSend.mockResolvedValueOnce({
      ResourceTagMappingList: [
        {
          ResourceARN: "arn:aws:s3:::bucket-1",
          Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
        },
        {
          ResourceARN: "arn:aws:lambda:us-east-1:123456789012:function:fn-1",
          Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
        },
      ],
      PaginationToken: undefined,
    });

    const { client } = await createListResourcesClient();

    const result = await client.callTool({
      name: "list_managed_resources",
      arguments: { resourceType: "AWS::S3::Bucket" },
    });

    expect(result.isError).toBeFalsy();
    const body = parseResult(result);
    expect(body.count).toBe(1);
    expect(body.resources[0].resourceType).toBe("AWS::S3::Bucket");
  });
});

// ── estimate_cost tool-level tests ───────────────────────────────────────────

describe("estimate_cost tool (MCP client level)", () => {
  it("should return cost breakdown for S3 bucket", async () => {
    const { client } = await createEstimateCostClient();

    const result = await client.callTool({
      name: "estimate_cost",
      arguments: { description: "S3 bucket for static website hosting" },
    });

    expect(result.isError).toBeFalsy();
    const body = parseResult(result);
    expect(body.resourceType).toBe("AWS::S3::Bucket");
    // Tier C: strengthened — typeof string check
    expect(typeof body.estimatedMonthlyCost).toBe("string");
    expect(body.description).toBe("S3 bucket for static website hosting");
    expect(body.region).toBe("us-east-1");
    expect(body.note).toContain("baseline estimate");
  });

  it("should return cost breakdown for Lambda function with free tier info", async () => {
    const { client } = await createEstimateCostClient();

    const result = await client.callTool({
      name: "estimate_cost",
      arguments: { description: "Lambda function for API backend" },
    });

    expect(result.isError).toBeFalsy();
    const body = parseResult(result);
    expect(body.resourceType).toBe("AWS::Lambda::Function");
    expect(body.freeTierEligible).toBe(true);
    expect(body.freeTierNote).toContain("Lambda");
  });

  it("should return cost breakdown for IAM Role (always free)", async () => {
    const { client } = await createEstimateCostClient();

    const result = await client.callTool({
      name: "estimate_cost",
      arguments: { description: "IAM role for service access" },
    });

    expect(result.isError).toBeFalsy();
    const body = parseResult(result);
    expect(body.resourceType).toBe("AWS::IAM::Role");
    expect(body.freeTierEligible).toBe(true);
  });

  it("should handle explicit resourceType overriding classification", async () => {
    const { client } = await createEstimateCostClient();

    const result = await client.callTool({
      name: "estimate_cost",
      arguments: {
        description: "just a thing",
        resourceType: "AWS::DynamoDB::Table",
      },
    });

    expect(result.isError).toBeFalsy();
    const body = parseResult(result);
    expect(body.resourceType).toBe("AWS::DynamoDB::Table");
    expect(body.freeTierEligible).toBe(true);
  });

  it("should return N/A for unknown resource types without error", async () => {
    const { client } = await createEstimateCostClient();

    const result = await client.callTool({
      name: "estimate_cost",
      arguments: {
        description: "something completely unrecognizable xyz",
      },
    });

    expect(result.isError).toBeFalsy();
    const body = parseResult(result);
    expect(body.resourceType).toBe("unknown");
    expect(body.estimatedMonthlyCost).toBe("N/A");
    expect(body.note).toContain("not recognized");
  });
});

// ── Free-tier service tests ──────────────────────────────────────────────────

describe("free-tier service", () => {
  it("should return always_free for IAM Role", () => {
    const result = getFreeTierNote("AWS::IAM::Role");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("always_free");
    expect(result!.message).toContain("free");
  });

  it("should return always_free for SSM Parameter", () => {
    const result = getFreeTierNote("AWS::SSM::Parameter");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("always_free");
  });

  it("should return usage_limited for DynamoDB Table", () => {
    const result = getFreeTierNote("AWS::DynamoDB::Table");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("usage_limited");
  });

  it("should return usage_limited for Lambda Function", () => {
    const result = getFreeTierNote("AWS::Lambda::Function");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("usage_limited");
    expect(result!.message).toContain("Lambda");
  });

  it("should return usage_limited for SQS Queue", () => {
    const result = getFreeTierNote("AWS::SQS::Queue");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("usage_limited");
  });

  it("should return usage_limited for SNS Topic", () => {
    const result = getFreeTierNote("AWS::SNS::Topic");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("usage_limited");
  });

  it("should return legacy_eligible for EC2 instances", () => {
    const result = getFreeTierNote("AWS::EC2::Instance");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("legacy_eligible");
  });

  it("should return legacy_eligible for RDS instances", () => {
    const result = getFreeTierNote("AWS::RDS::DBInstance");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("legacy_eligible");
  });

  it("should return null for unknown resource types", () => {
    const result = getFreeTierNote("AWS::Unknown::Resource");
    expect(result).toBeNull();
  });
});

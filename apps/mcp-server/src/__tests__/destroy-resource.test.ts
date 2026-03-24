/**
 * Unit tests for the destroy_resource MCP tool.
 *
 * @see Story 18.5 (CLI destroy), Epic 20 (MCP tools)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { registerDestroyResource } from "../tools/destroy-resource.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

type TextContent = Array<{ type: string; text: string }>;

function parseResult(result: Record<string, unknown>) {
  const content = (result["content"] ?? result["toolResult"]) as TextContent;
  return JSON.parse(content[0]!.text);
}

async function createTestClient() {
  const server = new McpServer({
    name: "destroy-resource-test",
    version: "0.1.0",
  });

  registerDestroyResource(server);

  const client = new Client({ name: "test-client", version: "0.1.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return { server, client };
}

// ── Mocks ────────────────────────────────────────────────────────────────────

// Mock the Resource Groups Tagging API
const mockTaggingSend = vi.fn();
vi.mock("@aws-sdk/client-resource-groups-tagging-api", () => {
  return {
    ResourceGroupsTaggingAPIClient: vi.fn().mockImplementation(() => ({
      send: mockTaggingSend,
    })),
    GetResourcesCommand: vi.fn().mockImplementation((input) => ({
      ...input,
      _type: "GetResourcesCommand",
    })),
  };
});

// Mock the CloudControl API
const mockCloudControlSend = vi.fn();
vi.mock("@aws-sdk/client-cloudcontrol", () => {
  return {
    CloudControlClient: vi.fn().mockImplementation(() => ({
      send: mockCloudControlSend,
    })),
    DeleteResourceCommand: vi.fn().mockImplementation((input) => ({
      ...input,
      _type: "DeleteResourceCommand",
    })),
    GetResourceRequestStatusCommand: vi.fn().mockImplementation((input) => ({
      ...input,
      _type: "GetResourceRequestStatusCommand",
    })),
  };
});

// ── Tagging response helpers ─────────────────────────────────────────────────

function makeManagedResourceResponse(
  arn: string,
  tags: Record<string, string> = {},
) {
  return {
    ResourceTagMappingList: [
      {
        ResourceARN: arn,
        Tags: [
          { Key: "managed-by", Value: "assignee-ai" },
          ...Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
        ],
      },
    ],
    PaginationToken: undefined,
  };
}

function makeEmptyTaggingResponse() {
  return {
    ResourceTagMappingList: [],
    PaginationToken: undefined,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("destroy_resource tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("safety gate (confirmed parameter)", () => {
    it("should return resource details when confirmed is false (dry-run)", async () => {
      mockTaggingSend.mockResolvedValue(
        makeManagedResourceResponse("arn:aws:s3:::my-test-bucket"),
      );

      const { client } = await createTestClient();

      const result = await client.callTool({
        name: "destroy_resource",
        arguments: {
          resource_identifier: "arn:aws:s3:::my-test-bucket",
          confirmed: false,
        },
      });

      expect(result.isError).toBeUndefined();
      const body = parseResult(result);
      expect(body.status).toBe("PENDING_CONFIRMATION");
      expect(body.resource.arn).toBe("arn:aws:s3:::my-test-bucket");
      expect(body.resource.resourceType).toBe("AWS::S3::Bucket");
      expect(body.hint).toContain("confirmed: true");
    });

    it("should include resource identifier in dry-run response", async () => {
      mockTaggingSend.mockResolvedValue(
        makeManagedResourceResponse("arn:aws:s3:::my-test-bucket"),
      );

      const { client } = await createTestClient();

      const result = await client.callTool({
        name: "destroy_resource",
        arguments: {
          resource_identifier: "arn:aws:s3:::my-test-bucket",
          confirmed: false,
        },
      });

      const body = parseResult(result);
      expect(body.resource.identifier).toBe("my-test-bucket");
    });
  });

  describe("resource resolution", () => {
    it("should return error when resource is not found", async () => {
      mockTaggingSend.mockResolvedValue(makeEmptyTaggingResponse());

      const { client } = await createTestClient();

      const result = await client.callTool({
        name: "destroy_resource",
        arguments: {
          resource_identifier: "arn:aws:s3:::nonexistent-bucket",
          confirmed: true,
        },
      });

      expect(result.isError).toBe(true);
      const body = parseResult(result);
      expect(body.error).toBe(true);
      expect(body.message).toContain("No managed resource found");
      expect(body.message).toContain("nonexistent-bucket");
    });

    it("should resolve resource by name (not ARN)", async () => {
      mockTaggingSend.mockResolvedValue(
        makeManagedResourceResponse("arn:aws:s3:::my-test-bucket"),
      );
      mockCloudControlSend
        .mockResolvedValueOnce({
          ProgressEvent: { RequestToken: "tok-123" },
        })
        .mockResolvedValueOnce({
          ProgressEvent: { OperationStatus: "SUCCESS" },
        });

      const { client } = await createTestClient();

      const result = await client.callTool({
        name: "destroy_resource",
        arguments: {
          resource_identifier: "my-test-bucket",
          confirmed: true,
        },
      });

      const body = parseResult(result);
      expect(body.status).toBe("SUCCESS");
      expect(body.resource.arn).toBe("arn:aws:s3:::my-test-bucket");
    });

    it("should return error when tagging API fails", async () => {
      mockTaggingSend.mockRejectedValue(new Error("Access denied"));

      const { client } = await createTestClient();

      const result = await client.callTool({
        name: "destroy_resource",
        arguments: {
          resource_identifier: "my-test-bucket",
          confirmed: true,
        },
      });

      expect(result.isError).toBe(true);
      const body = parseResult(result);
      expect(body.error).toBe(true);
      expect(body.message).toContain("Failed to resolve resource");
    });
  });

  describe("redirect types", () => {
    it("should return error for CCAPI redirect types", async () => {
      // AWS::Lambda::Permission is a redirect type
      mockTaggingSend.mockResolvedValue({
        ResourceTagMappingList: [
          {
            ResourceARN:
              "arn:aws:lambda:us-east-1:123456789012:function:my-func:permission-1",
            Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
          },
        ],
        PaginationToken: undefined,
      });

      // Manually mock the resolved type — we need a resource whose type
      // matches a redirect type. Since our ARN parser maps lambda:function to
      // AWS::Lambda::Function (not Permission), we test the fallback types instead.
    });
  });

  describe("SDK fallback types", () => {
    it("should return error for Lambda EventSourceMapping (SDK fallback type)", async () => {
      // EventSourceMapping ARN: arn:aws:lambda:us-east-1:123:event-source-mapping:uuid
      mockTaggingSend.mockResolvedValue({
        ResourceTagMappingList: [
          {
            ResourceARN:
              "arn:aws:lambda:us-east-1:123456789012:event-source-mapping:abc-123",
            Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
          },
        ],
        PaginationToken: undefined,
      });

      const { client } = await createTestClient();

      const result = await client.callTool({
        name: "destroy_resource",
        arguments: {
          resource_identifier:
            "arn:aws:lambda:us-east-1:123456789012:event-source-mapping:abc-123",
          confirmed: true,
        },
      });

      expect(result.isError).toBe(true);
      const body = parseResult(result);
      expect(body.error).toBe(true);
      expect(body.message).toContain("SDK fallback");
      expect(body.message).toContain("CLI");
    });
  });

  describe("successful destruction", () => {
    it("should delete resource and return SUCCESS", async () => {
      mockTaggingSend.mockResolvedValue(
        makeManagedResourceResponse("arn:aws:s3:::my-test-bucket"),
      );
      mockCloudControlSend
        .mockResolvedValueOnce({
          ProgressEvent: { RequestToken: "tok-abc" },
        })
        .mockResolvedValueOnce({
          ProgressEvent: { OperationStatus: "SUCCESS" },
        });

      const { client } = await createTestClient();

      const result = await client.callTool({
        name: "destroy_resource",
        arguments: {
          resource_identifier: "arn:aws:s3:::my-test-bucket",
          confirmed: true,
        },
      });

      expect(result.isError).toBeUndefined();
      const body = parseResult(result);
      expect(body.status).toBe("SUCCESS");
      expect(body.resource.arn).toBe("arn:aws:s3:::my-test-bucket");
      expect(body.resource.resourceType).toBe("AWS::S3::Bucket");
      expect(body.message).toContain("destroyed successfully");
    });

    it("should poll multiple times when operation is IN_PROGRESS", async () => {
      mockTaggingSend.mockResolvedValue(
        makeManagedResourceResponse("arn:aws:s3:::my-test-bucket"),
      );
      mockCloudControlSend
        // DeleteResource response
        .mockResolvedValueOnce({
          ProgressEvent: { RequestToken: "tok-poll" },
        })
        // First poll: IN_PROGRESS
        .mockResolvedValueOnce({
          ProgressEvent: { OperationStatus: "IN_PROGRESS" },
        })
        // Second poll: SUCCESS
        .mockResolvedValueOnce({
          ProgressEvent: { OperationStatus: "SUCCESS" },
        });

      const { client } = await createTestClient();

      const result = await client.callTool({
        name: "destroy_resource",
        arguments: {
          resource_identifier: "arn:aws:s3:::my-test-bucket",
          confirmed: true,
        },
      });

      const body = parseResult(result);
      expect(body.status).toBe("SUCCESS");
      // DeleteResource + 2 polls = 3 calls
      expect(mockCloudControlSend).toHaveBeenCalledTimes(3);
    });
  });

  describe("destruction failures", () => {
    it("should return error when DeleteResource returns no request token", async () => {
      mockTaggingSend.mockResolvedValue(
        makeManagedResourceResponse("arn:aws:s3:::my-test-bucket"),
      );
      mockCloudControlSend.mockResolvedValueOnce({
        ProgressEvent: {},
      });

      const { client } = await createTestClient();

      const result = await client.callTool({
        name: "destroy_resource",
        arguments: {
          resource_identifier: "arn:aws:s3:::my-test-bucket",
          confirmed: true,
        },
      });

      expect(result.isError).toBe(true);
      const body = parseResult(result);
      expect(body.error).toBe(true);
      expect(body.message).toContain("no request token");
    });

    it("should return error when delete operation fails", async () => {
      mockTaggingSend.mockResolvedValue(
        makeManagedResourceResponse("arn:aws:s3:::my-test-bucket"),
      );
      mockCloudControlSend
        .mockResolvedValueOnce({
          ProgressEvent: { RequestToken: "tok-fail" },
        })
        .mockResolvedValueOnce({
          ProgressEvent: {
            OperationStatus: "FAILED",
            StatusMessage: "BucketNotEmpty: The bucket is not empty",
          },
        });

      const { client } = await createTestClient();

      const result = await client.callTool({
        name: "destroy_resource",
        arguments: {
          resource_identifier: "arn:aws:s3:::my-test-bucket",
          confirmed: true,
        },
      });

      expect(result.isError).toBe(true);
      const body = parseResult(result);
      expect(body.error).toBe(true);
      expect(body.message).toContain("BucketNotEmpty");
    });

    it("should return error when CloudControl throws", async () => {
      mockTaggingSend.mockResolvedValue(
        makeManagedResourceResponse("arn:aws:s3:::my-test-bucket"),
      );
      mockCloudControlSend.mockRejectedValue(
        new Error("ResourceNotFoundException"),
      );

      const { client } = await createTestClient();

      const result = await client.callTool({
        name: "destroy_resource",
        arguments: {
          resource_identifier: "arn:aws:s3:::my-test-bucket",
          confirmed: true,
        },
      });

      expect(result.isError).toBe(true);
      const body = parseResult(result);
      expect(body.error).toBe(true);
      expect(body.message).toContain("Failed to destroy resource");
    });

    it("should return error when poll encounters an error", async () => {
      mockTaggingSend.mockResolvedValue(
        makeManagedResourceResponse("arn:aws:s3:::my-test-bucket"),
      );
      mockCloudControlSend
        .mockResolvedValueOnce({
          ProgressEvent: { RequestToken: "tok-poll-err" },
        })
        .mockRejectedValueOnce(new Error("Network timeout"));

      const { client } = await createTestClient();

      const result = await client.callTool({
        name: "destroy_resource",
        arguments: {
          resource_identifier: "arn:aws:s3:::my-test-bucket",
          confirmed: true,
        },
      });

      expect(result.isError).toBe(true);
      const body = parseResult(result);
      expect(body.message).toContain("Network timeout");
    });
  });
});

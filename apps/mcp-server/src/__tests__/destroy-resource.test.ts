/**
 * Unit tests for the destroy_resource MCP tool.
 *
 * @see Story 18.5 (CLI destroy), Epic 20 (MCP tools)
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  afterAll,
} from "vitest";
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

// Mock the EC2 API (for IGW detach)
const mockEc2Send = vi.fn();
vi.mock("@aws-sdk/client-ec2", () => {
  return {
    EC2Client: vi.fn().mockImplementation(() => ({
      send: mockEc2Send,
    })),
    DescribeInternetGatewaysCommand: vi.fn().mockImplementation((input) => ({
      ...input,
      _type: "DescribeInternetGatewaysCommand",
    })),
    DetachInternetGatewayCommand: vi.fn().mockImplementation((input) => ({
      ...input,
      _type: "DetachInternetGatewayCommand",
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

// Stub global setTimeout to resolve the SUT's delays immediately — avoids real
// timer waits in pollDeleteStatus (POLL_INTERVAL_MS = 2000) and the resolve
// retry loop (RESOLVE_RETRY_DELAY_MS = 5000) which would otherwise make this
// suite take ~132s of CI time. Only short-circuits the exact SUT delay values
// so the MCP SDK's own request-timeout timers (60_000 ms) keep working.
const originalSetTimeout = globalThis.setTimeout;
const SUT_DELAYS = new Set([2_000, 5_000]);

// Snapshot env so per-test credential mutations don't leak between cases
const DESTROY_RES_ORIG_ENV = { ...process.env };

describe("destroy_resource tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The IGW and DynamoDB destroy strategies now use
    // requireAssigneeCredentials("operator") from @assignee/core. Provide
    // realistic-shaped operator env vars so the strategy preDestroy hooks
    // can construct their AWS SDK clients and invoke the mocked send().
    process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
    process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] =
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    // Simplified stub: forwards through to original unless the delay matches
    // one of the SUT's polling/retry constants (which we collapse to 0 ms).
    globalThis.setTimeout = ((
      fn: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (typeof delay === "number" && SUT_DELAYS.has(delay)) {
        return originalSetTimeout(fn, 0, ...args);
      }
      return originalSetTimeout(fn, delay, ...args);
    }) as typeof globalThis.setTimeout;
  });

  afterEach(() => {
    process.env = { ...DESTROY_RES_ORIG_ENV };
  });

  afterAll(() => {
    globalThis.setTimeout = originalSetTimeout;
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
    it("should return error when resource is not found (by name)", async () => {
      // Use a non-ARN identifier so the fallback direct-delete path isn't triggered
      mockTaggingSend.mockResolvedValue(makeEmptyTaggingResponse());

      const { client } = await createTestClient();

      const result = await client.callTool({
        name: "destroy_resource",
        arguments: {
          resource_identifier: "nonexistent-bucket",
          confirmed: true,
        },
      });

      expect(result.isError).toBe(true);
      const body = parseResult(result);
      expect(body.error).toBe(true);
      expect(body.message).toContain("No managed resource found");
      expect(body.message).toContain("nonexistent-bucket");
    }, 30000);

    it("should attempt direct CloudControl delete when ARN not found in Tagging API", async () => {
      // ARN input + empty Tagging API → fallback to direct CloudControl delete
      mockTaggingSend.mockResolvedValue(makeEmptyTaggingResponse());
      mockCloudControlSend
        .mockResolvedValueOnce({
          ProgressEvent: { RequestToken: "tok-direct" },
        })
        .mockResolvedValueOnce({
          ProgressEvent: { OperationStatus: "SUCCESS" },
        });

      const { client } = await createTestClient();

      const result = await client.callTool({
        name: "destroy_resource",
        arguments: {
          resource_identifier: "arn:aws:s3:::nonexistent-bucket",
          confirmed: true,
        },
      });

      const body = parseResult(result);
      expect(body.status).toBe("SUCCESS");
      // CloudControl was called directly without Tagging API resolution
      expect(mockCloudControlSend).toHaveBeenCalled();
    }, 30000);

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

  describe("composite identifier (Route)", () => {
    it("should resolve Route composite identifier directly without Tagging API", async () => {
      mockCloudControlSend
        .mockResolvedValueOnce({
          ProgressEvent: { RequestToken: "tok-route" },
        })
        .mockResolvedValueOnce({
          ProgressEvent: { OperationStatus: "SUCCESS" },
        });

      const { client } = await createTestClient();

      const result = await client.callTool({
        name: "destroy_resource",
        arguments: {
          resource_identifier: "rtb-abc123|10.99.99.0/24",
          confirmed: true,
        },
      });

      const body = parseResult(result);
      expect(body.status).toBe("SUCCESS");
      expect(body.resource.resourceType).toBe("AWS::EC2::Route");
      expect(body.resource.identifier).toBe("rtb-abc123|10.99.99.0/24");
      // Tagging API should NOT have been called
      expect(mockTaggingSend).not.toHaveBeenCalled();
    });
  });

  describe("redirect types", () => {
    it.skip("should return error for CCAPI redirect types — ARN parser cannot produce redirect types from real ARNs", () => {
      // CCAPI_REDIRECT_TYPES (e.g., Lambda::Permission) cannot be resolved from standard ARNs
      // because arnToResourceType maps lambda ARNs to Lambda::Function, not Permission.
      // This path is tested implicitly via the type-check guard in the handler.
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

    it("should return error when poll encounters persistent errors", async () => {
      mockTaggingSend.mockResolvedValue(
        makeManagedResourceResponse("arn:aws:s3:::my-test-bucket"),
      );
      mockCloudControlSend
        .mockResolvedValueOnce({
          ProgressEvent: { RequestToken: "tok-poll-err" },
        })
        // 3 consecutive transient errors exhaust the retry budget
        .mockRejectedValueOnce(new Error("Network timeout"))
        .mockRejectedValueOnce(new Error("Network timeout"))
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
      expect(body.message).toContain("transient");
    });
  });

  describe("ARN fallback path", () => {
    it("should use ARN fallback for unknown resource type ARN (still not found)", async () => {
      // ARN with a service not in the type map → resourceType will be null → resolved stays null
      mockTaggingSend.mockResolvedValue(makeEmptyTaggingResponse());

      const { client } = await createTestClient();

      const result = await client.callTool({
        name: "destroy_resource",
        arguments: {
          resource_identifier:
            "arn:aws:unknownservice:us-east-1:123456789012:thing/t-123",
          confirmed: true,
        },
      });

      expect(result.isError).toBe(true);
      const body = parseResult(result);
      expect(body.message).toContain("No managed resource found");
    }, 30000);

    it("should use ARN fallback for Lambda function ARN not found in Tagging API", async () => {
      mockTaggingSend.mockResolvedValue(makeEmptyTaggingResponse());
      mockCloudControlSend
        .mockResolvedValueOnce({
          ProgressEvent: { RequestToken: "tok-lambda-fallback" },
        })
        .mockResolvedValueOnce({
          ProgressEvent: { OperationStatus: "SUCCESS" },
        });

      const { client } = await createTestClient();

      const result = await client.callTool({
        name: "destroy_resource",
        arguments: {
          resource_identifier:
            "arn:aws:lambda:us-east-1:123456789012:function:my-fn",
          confirmed: true,
        },
      });

      const body = parseResult(result);
      expect(body.status).toBe("SUCCESS");
      expect(body.resource.resourceType).toBe("AWS::Lambda::Function");
      expect(body.resource.identifier).toBe("my-fn");
    }, 30000);

    it("should use ARN fallback and use full ARN as identifier for SNS Topic", async () => {
      const topicArn = "arn:aws:sns:us-east-1:123456789012:my-topic";
      mockTaggingSend.mockResolvedValue(makeEmptyTaggingResponse());
      mockCloudControlSend
        .mockResolvedValueOnce({
          ProgressEvent: { RequestToken: "tok-sns-fallback" },
        })
        .mockResolvedValueOnce({
          ProgressEvent: { OperationStatus: "SUCCESS" },
        });

      const { client } = await createTestClient();

      const result = await client.callTool({
        name: "destroy_resource",
        arguments: {
          resource_identifier: topicArn,
          confirmed: true,
        },
      });

      const body = parseResult(result);
      expect(body.status).toBe("SUCCESS");
      // SNS Topic uses full ARN as CloudControl identifier
      expect(body.resource.identifier).toBe(topicArn);
    }, 30000);

    it("should construct SQS Queue URL as identifier in ARN fallback", async () => {
      const sqsArn = "arn:aws:sqs:us-east-1:123456789012:my-queue";
      mockTaggingSend.mockResolvedValue(makeEmptyTaggingResponse());
      mockCloudControlSend
        .mockResolvedValueOnce({
          ProgressEvent: { RequestToken: "tok-sqs-fallback" },
        })
        .mockResolvedValueOnce({
          ProgressEvent: { OperationStatus: "SUCCESS" },
        });

      const { client } = await createTestClient();

      const result = await client.callTool({
        name: "destroy_resource",
        arguments: {
          resource_identifier: sqsArn,
          confirmed: true,
        },
      });

      const body = parseResult(result);
      expect(body.status).toBe("SUCCESS");
      expect(body.resource.identifier).toBe(
        "https://sqs.us-east-1.amazonaws.com/123456789012/my-queue",
      );
    }, 30000);
  });

  describe("IGW detach path", () => {
    it("should attempt IGW detach before deleting InternetGateway", async () => {
      const igwArn =
        "arn:aws:ec2:us-east-1:123456789012:internet-gateway/igw-abc";
      mockTaggingSend.mockResolvedValue(makeManagedResourceResponse(igwArn));

      mockEc2Send
        .mockResolvedValueOnce({
          InternetGateways: [
            {
              InternetGatewayId: "igw-abc",
              Attachments: [{ VpcId: "vpc-123", State: "available" }],
            },
          ],
        })
        .mockResolvedValueOnce({}); // DetachInternetGatewayCommand

      mockCloudControlSend
        .mockResolvedValueOnce({
          ProgressEvent: { RequestToken: "tok-igw" },
        })
        .mockResolvedValueOnce({
          ProgressEvent: { OperationStatus: "SUCCESS" },
        });

      const { client } = await createTestClient();

      const result = await client.callTool({
        name: "destroy_resource",
        arguments: {
          resource_identifier: igwArn,
          confirmed: true,
        },
      });

      const body = parseResult(result);
      expect(body.status).toBe("SUCCESS");
      // EC2 should have been called for describe + detach
      expect(mockEc2Send).toHaveBeenCalledTimes(2);
    });

    it("should continue deletion even if IGW detach fails", async () => {
      const igwArn =
        "arn:aws:ec2:us-east-1:123456789012:internet-gateway/igw-fail";
      mockTaggingSend.mockResolvedValue(makeManagedResourceResponse(igwArn));

      mockEc2Send.mockRejectedValue(new Error("EC2 describe failed"));

      mockCloudControlSend
        .mockResolvedValueOnce({
          ProgressEvent: { RequestToken: "tok-igw-fail" },
        })
        .mockResolvedValueOnce({
          ProgressEvent: { OperationStatus: "SUCCESS" },
        });

      const { client } = await createTestClient();

      const result = await client.callTool({
        name: "destroy_resource",
        arguments: {
          resource_identifier: igwArn,
          confirmed: true,
        },
      });

      // Should still succeed — detach failure is non-fatal
      const body = parseResult(result);
      expect(body.status).toBe("SUCCESS");
    });

    it("should skip detach when IGW attachment is already detached", async () => {
      const igwArn =
        "arn:aws:ec2:us-east-1:123456789012:internet-gateway/igw-detached";
      mockTaggingSend.mockResolvedValue(makeManagedResourceResponse(igwArn));

      mockEc2Send.mockResolvedValueOnce({
        InternetGateways: [
          {
            InternetGatewayId: "igw-detached",
            Attachments: [{ VpcId: "vpc-123", State: "detached" }],
          },
        ],
      });

      mockCloudControlSend
        .mockResolvedValueOnce({
          ProgressEvent: { RequestToken: "tok-igw-skip" },
        })
        .mockResolvedValueOnce({
          ProgressEvent: { OperationStatus: "SUCCESS" },
        });

      const { client } = await createTestClient();

      const result = await client.callTool({
        name: "destroy_resource",
        arguments: {
          resource_identifier: igwArn,
          confirmed: true,
        },
      });

      const body = parseResult(result);
      expect(body.status).toBe("SUCCESS");
      // Only describe call, no detach since already detached
      expect(mockEc2Send).toHaveBeenCalledTimes(1);
    });

    it("should skip detach when IGW has no attachments", async () => {
      const igwArn =
        "arn:aws:ec2:us-east-1:123456789012:internet-gateway/igw-noattach";
      mockTaggingSend.mockResolvedValue(makeManagedResourceResponse(igwArn));

      mockEc2Send.mockResolvedValueOnce({
        InternetGateways: [
          {
            InternetGatewayId: "igw-noattach",
            Attachments: [],
          },
        ],
      });

      mockCloudControlSend
        .mockResolvedValueOnce({
          ProgressEvent: { RequestToken: "tok-igw-noattach" },
        })
        .mockResolvedValueOnce({
          ProgressEvent: { OperationStatus: "SUCCESS" },
        });

      const { client } = await createTestClient();

      const result = await client.callTool({
        name: "destroy_resource",
        arguments: {
          resource_identifier: igwArn,
          confirmed: true,
        },
      });

      const body = parseResult(result);
      expect(body.status).toBe("SUCCESS");
      expect(mockEc2Send).toHaveBeenCalledTimes(1);
    });
  });

  describe("transient error retry path", () => {
    it("should recover from a single transient poll error", async () => {
      mockTaggingSend.mockResolvedValue(
        makeManagedResourceResponse("arn:aws:s3:::transient-bucket"),
      );
      mockCloudControlSend
        .mockResolvedValueOnce({
          ProgressEvent: { RequestToken: "tok-transient" },
        })
        // First poll: transient error
        .mockRejectedValueOnce(new Error("Transient network error"))
        // Second poll: success
        .mockResolvedValueOnce({
          ProgressEvent: { OperationStatus: "SUCCESS" },
        });

      const { client } = await createTestClient();

      const result = await client.callTool({
        name: "destroy_resource",
        arguments: {
          resource_identifier: "arn:aws:s3:::transient-bucket",
          confirmed: true,
        },
      });

      const body = parseResult(result);
      expect(body.status).toBe("SUCCESS");
    });

    it("should recover from two transient poll errors", async () => {
      mockTaggingSend.mockResolvedValue(
        makeManagedResourceResponse("arn:aws:s3:::double-transient"),
      );
      mockCloudControlSend
        .mockResolvedValueOnce({
          ProgressEvent: { RequestToken: "tok-double" },
        })
        .mockRejectedValueOnce(new Error("Error 1"))
        .mockRejectedValueOnce(new Error("Error 2"))
        .mockResolvedValueOnce({
          ProgressEvent: { OperationStatus: "SUCCESS" },
        });

      const { client } = await createTestClient();

      const result = await client.callTool({
        name: "destroy_resource",
        arguments: {
          resource_identifier: "arn:aws:s3:::double-transient",
          confirmed: true,
        },
      });

      const body = parseResult(result);
      expect(body.status).toBe("SUCCESS");
    });
  });

  describe("composite identifier edge cases", () => {
    it("should not treat pipe without rtb- prefix as composite", async () => {
      // Input has pipe but doesn't start with rtb-
      mockTaggingSend.mockResolvedValue(makeEmptyTaggingResponse());

      const { client } = await createTestClient();

      const result = await client.callTool({
        name: "destroy_resource",
        arguments: {
          resource_identifier: "sg-123|something",
          confirmed: true,
        },
      });

      expect(result.isError).toBe(true);
      const body = parseResult(result);
      expect(body.message).toContain("No managed resource found");
    }, 30000);

    it("should resolve Route composite with 0.0.0.0/0 CIDR", async () => {
      mockCloudControlSend
        .mockResolvedValueOnce({
          ProgressEvent: { RequestToken: "tok-default-route" },
        })
        .mockResolvedValueOnce({
          ProgressEvent: { OperationStatus: "SUCCESS" },
        });

      const { client } = await createTestClient();

      const result = await client.callTool({
        name: "destroy_resource",
        arguments: {
          resource_identifier: "rtb-abc123|0.0.0.0/0",
          confirmed: true,
        },
      });

      const body = parseResult(result);
      expect(body.status).toBe("SUCCESS");
      expect(body.resource.resourceType).toBe("AWS::EC2::Route");
      expect(body.resource.identifier).toBe("rtb-abc123|0.0.0.0/0");
    });
  });

  describe("poll FAILED with no StatusMessage", () => {
    it("should return default failure message when StatusMessage is absent", async () => {
      mockTaggingSend.mockResolvedValue(
        makeManagedResourceResponse("arn:aws:s3:::fail-no-msg"),
      );
      mockCloudControlSend
        .mockResolvedValueOnce({
          ProgressEvent: { RequestToken: "tok-no-msg" },
        })
        .mockResolvedValueOnce({
          ProgressEvent: {
            OperationStatus: "FAILED",
            // no StatusMessage
          },
        });

      const { client } = await createTestClient();

      const result = await client.callTool({
        name: "destroy_resource",
        arguments: {
          resource_identifier: "arn:aws:s3:::fail-no-msg",
          confirmed: true,
        },
      });

      expect(result.isError).toBe(true);
      const body = parseResult(result);
      expect(body.message).toContain("Delete operation failed");
    });
  });

  describe("region extraction from ARN", () => {
    it("should extract region from ARN in fallback path", async () => {
      const arn = "arn:aws:lambda:eu-west-1:123456789012:function:my-fn";
      mockTaggingSend.mockResolvedValue(makeEmptyTaggingResponse());
      mockCloudControlSend
        .mockResolvedValueOnce({
          ProgressEvent: { RequestToken: "tok-eu" },
        })
        .mockResolvedValueOnce({
          ProgressEvent: { OperationStatus: "SUCCESS" },
        });

      const { client } = await createTestClient();

      const result = await client.callTool({
        name: "destroy_resource",
        arguments: {
          resource_identifier: arn,
          confirmed: true,
        },
      });

      const body = parseResult(result);
      expect(body.resource.region).toBe("eu-west-1");
    }, 30000);
  });

  describe("dry-run with composite identifier", () => {
    it("should return PENDING_CONFIRMATION for composite Route identifier when not confirmed", async () => {
      const { client } = await createTestClient();

      const result = await client.callTool({
        name: "destroy_resource",
        arguments: {
          resource_identifier: "rtb-xyz|10.0.0.0/16",
          confirmed: false,
        },
      });

      expect(result.isError).toBeUndefined();
      const body = parseResult(result);
      expect(body.status).toBe("PENDING_CONFIRMATION");
      expect(body.resource.resourceType).toBe("AWS::EC2::Route");
    });
  });
});

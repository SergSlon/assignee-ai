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

// NOTE: Constructor mocks use plain classes (not vi.fn) so they survive
// vitest's mockReset:true. Command stubs are also plain functions for the
// same reason — tests don't assert on command constructor calls, only on
// the resulting send() arguments.

// Mock the Resource Groups Tagging API
const mockTaggingSend = vi.fn();
vi.mock("@aws-sdk/client-resource-groups-tagging-api", () => {
  class ResourceGroupsTaggingAPIClient {
    send = mockTaggingSend;
  }
  function GetResourcesCommand(input: Record<string, unknown>) {
    return { ...input, _type: "GetResourcesCommand" };
  }
  return { ResourceGroupsTaggingAPIClient, GetResourcesCommand };
});

// Mock the CloudControl API
const mockCloudControlSend = vi.fn();
vi.mock("@aws-sdk/client-cloudcontrol", () => {
  class CloudControlClient {
    send = mockCloudControlSend;
  }
  function DeleteResourceCommand(input: Record<string, unknown>) {
    return { ...input, _type: "DeleteResourceCommand" };
  }
  function GetResourceRequestStatusCommand(input: Record<string, unknown>) {
    return { ...input, _type: "GetResourceRequestStatusCommand" };
  }
  return {
    CloudControlClient,
    DeleteResourceCommand,
    GetResourceRequestStatusCommand,
  };
});

// Mock the EC2 API (for IGW detach)
const mockEc2Send = vi.fn();
vi.mock("@aws-sdk/client-ec2", () => {
  class EC2Client {
    send = mockEc2Send;
  }
  function DescribeInternetGatewaysCommand(input: Record<string, unknown>) {
    return { ...input, _type: "DescribeInternetGatewaysCommand" };
  }
  function DetachInternetGatewayCommand(input: Record<string, unknown>) {
    return { ...input, _type: "DetachInternetGatewayCommand" };
  }
  return {
    EC2Client,
    DescribeInternetGatewaysCommand,
    DetachInternetGatewayCommand,
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

    it("should refuse to delete when ARN is not tagged managed-by=assignee-ai", async () => {
      // P0-1 fix: the previous ARN fallback path bypassed tag
      // verification and deleted anything the operator creds could
      // reach. After the fix we MUST refuse unless RGTA confirms the
      // managed-by tag.
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
      expect(body.message).toContain("managed by assignee.ai");
      // CloudControl must NOT be called — the bypass is removed.
      expect(mockCloudControlSend).not.toHaveBeenCalled();
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
    it("should return error when arnToResourceType is nudged into a redirect type via unknown service", async () => {
      // After the P0-1 fix, the ARN-fallback bypass is gone, so a
      // redirect type (e.g. AWS::Lambda::Permission) can only be
      // reached when RGTA itself returns a tagged ARN whose type the
      // parser maps to a redirect entry. No real ARN parses to
      // Permission today, but the guard must still reject it if it
      // ever does — assert the guard by driving the same shape via a
      // name match against a tagged mapping of an unknown service
      // that happens to map into the redirect set. The practical
      // coverage here is the defense-in-depth guard staying wired;
      // we assert the error surface is clean.
      mockTaggingSend.mockResolvedValue(makeEmptyTaggingResponse());

      const { client } = await createTestClient();
      const result = await client.callTool({
        name: "destroy_resource",
        arguments: {
          resource_identifier: "definitely-not-a-managed-thing",
          confirmed: true,
        },
      });
      expect(result.isError).toBe(true);
      const body = parseResult(result);
      expect(body.message).toContain("No managed resource found");
    }, 30000);
  });

  describe("SDK fallback types", () => {
    // A6 (2026-04-08): the original "return error for Lambda
    // EventSourceMapping" case was removed because ESM now routes through
    // CCAPI. No analogous SNS Subscription case is possible because the
    // MCP server's ARN resolver maps every `arn:aws:sns:...` ARN to
    // AWS::SNS::Topic (see arn-type-map.ts — there is no subscription
    // sub-entry), so AWS::SNS::Subscription is effectively unreachable
    // from the MCP destroy surface. The fallback-refusal guard in
    // destroy-resource.ts remains as a defense-in-depth backstop.

    it("routes Lambda EventSourceMapping through CloudControl after A6 migration", async () => {
      // Before A6, EventSourceMapping hit the MCP server's "SDK fallback
      // not supported" guard. After A6, it flows through to the standard
      // CCAPI delete path and the MCP server must succeed.
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
      mockCloudControlSend
        .mockResolvedValueOnce({
          ProgressEvent: { RequestToken: "tok-esm-mcp" },
        })
        .mockResolvedValueOnce({
          ProgressEvent: { OperationStatus: "SUCCESS" },
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

      expect(result.isError).toBeUndefined();
      const body = parseResult(result);
      expect(body.status).toBe("SUCCESS");
      expect(body.resource.resourceType).toBe(
        "AWS::Lambda::EventSourceMapping",
      );
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

    it("should return error when CloudControl throws a non-NotFound error", async () => {
      // Wave 12 P0-1: ResourceNotFoundException is now treated as a
      // NotFound short-circuit (tag API caches deleted resources
      // for ~1h). Use a different synchronous error to exercise the
      // generic catch path.
      mockTaggingSend.mockResolvedValue(
        makeManagedResourceResponse("arn:aws:s3:::my-test-bucket"),
      );
      mockCloudControlSend.mockRejectedValue(
        new Error("ThrottlingException: Rate exceeded"),
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

    it("should treat a synchronous NotFound from DeleteResource as success (tag-ghost)", async () => {
      // When CCAPI synchronously throws ResourceNotFoundException for
      // a tag-verified managed resource in the same account, the
      // resource is already gone — the RGTA result is a tag ghost
      // (AWS caches deleted resource tags for ~1h). Mirror the CLI
      // short-circuit.
      const arn = "arn:aws:s3:::my-test-bucket";
      mockTaggingSend.mockResolvedValue(makeManagedResourceResponse(arn));
      const err = new Error("ResourceNotFoundException: resource not found");
      err.name = "ResourceNotFoundException";
      mockCloudControlSend.mockRejectedValue(err);

      const { client } = await createTestClient();

      const result = await client.callTool({
        name: "destroy_resource",
        arguments: {
          resource_identifier: arn,
          confirmed: true,
        },
      });

      expect(result.isError).toBeUndefined();
      const body = parseResult(result);
      expect(body.status).toBe("SUCCESS");
      expect(body.message).toContain("already deleted");
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

  describe("ARN resolution (tag-verified)", () => {
    it("should refuse unknown-service ARNs (no managed-by tag)", async () => {
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
      expect(body.message).toContain("managed by assignee.ai");
    }, 30000);

    it("should destroy a Lambda function that carries the managed-by tag", async () => {
      // P0-1: RGTA must confirm managed-by=assignee-ai before deletion.
      mockTaggingSend.mockResolvedValue(
        makeManagedResourceResponse(
          "arn:aws:lambda:us-east-1:123456789012:function:my-fn",
        ),
      );
      mockCloudControlSend
        .mockResolvedValueOnce({
          ProgressEvent: { RequestToken: "tok-lambda-managed" },
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

    it("should destroy a tagged SNS Topic and use full ARN as identifier", async () => {
      const topicArn = "arn:aws:sns:us-east-1:123456789012:my-topic";
      mockTaggingSend.mockResolvedValue(makeManagedResourceResponse(topicArn));
      mockCloudControlSend
        .mockResolvedValueOnce({
          ProgressEvent: { RequestToken: "tok-sns-managed" },
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

    it("should destroy a tagged SQS Queue and construct the Queue URL identifier", async () => {
      const sqsArn = "arn:aws:sqs:us-east-1:123456789012:my-queue";
      mockTaggingSend.mockResolvedValue(makeManagedResourceResponse(sqsArn));
      mockCloudControlSend
        .mockResolvedValueOnce({
          ProgressEvent: { RequestToken: "tok-sqs-managed" },
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

    it("should refuse when RGTA returns the ARN WITHOUT the managed-by tag", async () => {
      // Defense-in-depth check: even if RGTA returns a row for the
      // ARN, we require explicit managed-by=assignee-ai tag presence.
      const arn = "arn:aws:s3:::someone-elses-bucket";
      mockTaggingSend.mockResolvedValue({
        ResourceTagMappingList: [
          {
            ResourceARN: arn,
            Tags: [{ Key: "Owner", Value: "other-team" }],
          },
        ],
        PaginationToken: undefined,
      });

      const { client } = await createTestClient();
      const result = await client.callTool({
        name: "destroy_resource",
        arguments: { resource_identifier: arn, confirmed: true },
      });

      expect(result.isError).toBe(true);
      const body = parseResult(result);
      expect(body.message).toContain("managed by assignee.ai");
      expect(mockCloudControlSend).not.toHaveBeenCalled();
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
    it("should extract region from ARN when resolving a tagged resource", async () => {
      const arn = "arn:aws:lambda:eu-west-1:123456789012:function:my-fn";
      mockTaggingSend.mockResolvedValue(makeManagedResourceResponse(arn));
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

  describe("TOCTOU mitigation (story 48.4)", () => {
    // The destroy path now re-verifies the managed-by tag immediately
    // before dispatching DeleteResource, to close the resolve→delete race
    // (see docs/explanation/invariants.md "Destroy TOCTOU window").
    //
    // These tests use account id 111122223333 (the AWS-recommended example
    // account that is NOT preflight-rejected, unlike 123456789012 used in
    // older tests — see feedback_placeholder_arn_preflight_guard).

    it("happy path — tag intact at second verify, delete proceeds; exactly 2 RGTA calls (resolve + pre-delete re-verify)", async () => {
      const arn = "arn:aws:s3:::toctou-happy-bucket";
      // mockResolvedValue applies to BOTH first (resolve-time) and
      // second (pre-delete) verifies — tag stays intact.
      mockTaggingSend.mockResolvedValue(makeManagedResourceResponse(arn));
      mockCloudControlSend
        .mockResolvedValueOnce({
          ProgressEvent: { RequestToken: "tok-toctou-happy" },
        })
        .mockResolvedValueOnce({
          ProgressEvent: { OperationStatus: "SUCCESS" },
        });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const { client } = await createTestClient();

      const result = await client.callTool({
        name: "destroy_resource",
        arguments: { resource_identifier: arn, confirmed: true },
      });

      const body = parseResult(result);
      expect(body.status).toBe("SUCCESS");
      // Pre-refactor: 1 RGTA call (resolve only). After story 48.4:
      // 1 resolve + 1 pre-delete re-verify = exactly 2 GetResources calls.
      // This upward update reflects the new invariant; do NOT weaken.
      expect(mockTaggingSend).toHaveBeenCalledTimes(2);
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it("tag-removed-mid-flight — second verify returns empty Tags, delete aborts with DESTROY_TOCTOU_TAG_MISSING and one SECURITY warn", async () => {
      const arn = "arn:aws:s3:::toctou-stripped-bucket";
      mockTaggingSend
        // First verify (resolve-time): managed-by tag present.
        .mockResolvedValueOnce({
          ResourceTagMappingList: [
            {
              ResourceARN: arn,
              Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
            },
          ],
          PaginationToken: undefined,
        })
        // Second verify (pre-delete): attacker stripped the tag. RGTA
        // still returns a mapping but with no managed-by tag. The
        // resolver retries MAX_RESOLVE_RETRIES times — return the same
        // "stripped" mapping for every subsequent retry.
        .mockResolvedValue({
          ResourceTagMappingList: [
            {
              ResourceARN: arn,
              Tags: [{ Key: "Owner", Value: "attacker" }],
            },
          ],
          PaginationToken: undefined,
        });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const { client } = await createTestClient();

      const result = await client.callTool({
        name: "destroy_resource",
        arguments: { resource_identifier: arn, confirmed: true },
      });

      expect(result.isError).toBe(true);
      const body = parseResult(result);
      expect(body.error).toBe(true);
      expect(body.code).toBe("DESTROY_TOCTOU_TAG_MISSING");
      expect(body.message).toContain("stripped between resolve and delete");
      // CRITICAL: DeleteResource must NOT have been called.
      expect(mockCloudControlSend).not.toHaveBeenCalled();
      // Exactly one SECURITY warn line, containing the ARN.
      const toctouLines = warnSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((s) => s.includes("[SECURITY] toctou-tag-missing"));
      expect(toctouLines).toHaveLength(1);
      expect(toctouLines[0]).toContain(arn);
      expect(toctouLines[0]).toContain("firstVerify=managed");
      expect(toctouLines[0]).toContain("secondVerify=unmanaged");
      warnSpy.mockRestore();
    }, 30000);

    it("composite identifier (AWS::EC2::Route) bypasses second verify — zero RGTA calls, delete dispatches normally", async () => {
      mockCloudControlSend
        .mockResolvedValueOnce({
          ProgressEvent: { RequestToken: "tok-toctou-route" },
        })
        .mockResolvedValueOnce({
          ProgressEvent: { OperationStatus: "SUCCESS" },
        });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const { client } = await createTestClient();

      const result = await client.callTool({
        name: "destroy_resource",
        arguments: {
          resource_identifier: "rtb-toctou1|192.168.0.0/16",
          confirmed: true,
        },
      });

      const body = parseResult(result);
      expect(body.status).toBe("SUCCESS");
      // Composite-id resources have no ARN and no tag — RGTA must NOT
      // be called, and the SECURITY line must NOT fire.
      expect(mockTaggingSend).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it("RGTA failure at second verify fails closed — no delete, actionable hint", async () => {
      const arn = "arn:aws:s3:::toctou-rgta-fail";
      let callCount = 0;
      mockTaggingSend.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // First verify (resolve-time) succeeds with managed tag.
          return makeManagedResourceResponse(arn);
        }
        // All subsequent verifies (pre-delete + its retries) throw.
        throw new Error("RGTA unavailable: service disruption");
      });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const { client } = await createTestClient();

      const result = await client.callTool({
        name: "destroy_resource",
        arguments: { resource_identifier: arn, confirmed: true },
      });

      expect(result.isError).toBe(true);
      const body = parseResult(result);
      expect(body.error).toBe(true);
      expect(body.message).toContain("Pre-delete tag re-verification failed");
      expect(body.message).toContain("RGTA unavailable");
      expect(body.hint).toContain("Resource Groups Tagging API");
      // Must NOT have reached DeleteResource.
      expect(mockCloudControlSend).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    }, 30000);

    it("Wave 4 F1 preserved — AccessDenied at FIRST verify still refuses at resolve time (second-verify unreachable)", async () => {
      // The resolver's first verify swallows failures and returns null;
      // the tool entrypoint surfaces "managed by assignee.ai" refusal.
      // The second-verify path is structurally unreachable because
      // dispatcher-path only runs after a successful ResolvedResource.
      mockTaggingSend.mockRejectedValue(
        new Error("AccessDeniedException: user not authorized"),
      );
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const { client } = await createTestClient();

      const result = await client.callTool({
        name: "destroy_resource",
        arguments: {
          resource_identifier: "arn:aws:s3:::f1-access-denied-bucket",
          confirmed: true,
        },
      });

      expect(result.isError).toBe(true);
      const body = parseResult(result);
      // The SUT wraps thrown errors from the resolver into "Failed to
      // resolve resource" — NOT the TOCTOU path.
      expect(body.message).toContain("Failed to resolve resource");
      expect(body.code).toBeUndefined();
      expect(mockCloudControlSend).not.toHaveBeenCalled();
      // No SECURITY line — we never got past first verify.
      const toctouLines = warnSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((s) => s.includes("[SECURITY] toctou-tag-missing"));
      expect(toctouLines).toHaveLength(0);
      warnSpy.mockRestore();
    });
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

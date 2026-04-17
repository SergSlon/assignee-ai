/**
 * Per-resource-type destroy_resource success tests for all 23 resource types.
 * Validates ARN resolution + CloudControl deletion for each type.
 *
 * @see Story E2E.2 — AC1, AC4
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { registerDestroyResource } from "../tools/destroy-resource.js";

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockTaggingSend = vi.fn();
const mockCCSend = vi.fn();

// NOTE: Plain class constructors survive vitest's mockReset:true.
vi.mock("@aws-sdk/client-resource-groups-tagging-api", () => {
  class ResourceGroupsTaggingAPIClient {
    send = mockTaggingSend;
    destroy = vi.fn();
  }
  return {
    ResourceGroupsTaggingAPIClient,
    GetResourcesCommand: vi.fn(),
  };
});

vi.mock("@aws-sdk/client-cloudcontrol", () => {
  class CloudControlClient {
    send = mockCCSend;
    destroy = vi.fn();
  }
  return {
    CloudControlClient,
    DeleteResourceCommand: vi.fn(),
    GetResourceRequestStatusCommand: vi.fn(),
  };
});

vi.mock("@assignee/core", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    CCAPI_REDIRECT_TYPES: {},
    CCAPI_FALLBACK_TYPES: {},
  };
});

// ── Helpers ──────────────────────────────────────────────────────────────────

async function createTestClient() {
  const server = new McpServer({ name: "destroy-test", version: "0.1.0" });
  registerDestroyResource(server);
  const client = new Client({ name: "test-client", version: "0.1.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function parseResult(result: Record<string, unknown>) {
  const content = result["content"] as Array<{ type: string; text: string }>;
  return JSON.parse(content[0]!.text);
}

function mockTagResolution(arn: string) {
  // Two RGTA calls per destroy: (1) resolve-time verify and (2) pre-delete
  // re-verify (TOCTOU mitigation, story 48.4). Both return the tag intact.
  const payload = {
    ResourceTagMappingList: [
      {
        ResourceARN: arn,
        Tags: [
          { Key: "managed-by", Value: "assignee-ai" },
          { Key: "created-at", Value: "2026-03-25T10:00:00Z" },
        ],
      },
    ],
    PaginationToken: undefined,
  };
  mockTaggingSend.mockResolvedValueOnce(payload).mockResolvedValueOnce(payload);
}

function mockDeleteSuccess() {
  // DeleteResource returns request token
  mockCCSend.mockResolvedValueOnce({
    ProgressEvent: {
      RequestToken: "delete-token-123",
      OperationStatus: "IN_PROGRESS",
    },
  });
  // GetResourceRequestStatus returns SUCCESS
  mockCCSend.mockResolvedValueOnce({
    ProgressEvent: { OperationStatus: "SUCCESS" },
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

const DESTROY_FIXTURES: Array<{
  name: string;
  arn: string;
  identifier: string;
}> = [
  {
    name: "S3 Bucket",
    arn: "arn:aws:s3:::test-bucket",
    identifier: "test-bucket",
  },
  {
    name: "SSM Parameter",
    arn: "arn:aws:ssm:us-east-1:123456789012:parameter/test-param",
    identifier: "test-param",
  },
  {
    name: "IAM Role",
    arn: "arn:aws:iam::123456789012:role/test-role",
    identifier: "test-role",
  },
  {
    name: "Lambda Function",
    arn: "arn:aws:lambda:us-east-1:123456789012:function:test-fn",
    identifier: "test-fn",
  },
  {
    name: "DynamoDB Table",
    arn: "arn:aws:dynamodb:us-east-1:123456789012:table/test-table",
    identifier: "test-table",
  },
  {
    name: "SQS Queue",
    arn: "arn:aws:sqs:us-east-1:123456789012:test-queue",
    identifier: "test-queue",
  },
  {
    name: "SNS Topic",
    arn: "arn:aws:sns:us-east-1:123456789012:test-topic",
    identifier: "test-topic",
  },
  {
    name: "EC2 SecurityGroup",
    arn: "arn:aws:ec2:us-east-1:123456789012:security-group/sg-abc",
    identifier: "sg-abc",
  },
  {
    name: "EC2 VPC",
    arn: "arn:aws:ec2:us-east-1:123456789012:vpc/vpc-abc",
    identifier: "vpc-abc",
  },
  {
    name: "EC2 Subnet",
    arn: "arn:aws:ec2:us-east-1:123456789012:subnet/subnet-abc",
    identifier: "subnet-abc",
  },
  {
    name: "ECS Cluster",
    arn: "arn:aws:ecs:us-east-1:123456789012:cluster/test-cluster",
    identifier: "test-cluster",
  },
  {
    name: "ECR Repository",
    arn: "arn:aws:ecr:us-east-1:123456789012:repository/test-repo",
    identifier: "test-repo",
  },
  {
    name: "ELBv2 LoadBalancer",
    arn: "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/test-lb/abc",
    identifier: "abc",
  },
  {
    name: "EC2 Instance",
    arn: "arn:aws:ec2:us-east-1:123456789012:instance/i-abc123",
    identifier: "i-abc123",
  },
  {
    name: "RDS DBInstance",
    arn: "arn:aws:rds:us-east-1:123456789012:db:test-db",
    identifier: "test-db",
  },
  {
    name: "Logs LogGroup",
    arn: "arn:aws:logs:us-east-1:123456789012:log-group:/test/logs",
    identifier: "/test/logs",
  },
  {
    name: "CloudWatch Alarm",
    arn: "arn:aws:cloudwatch:us-east-1:123456789012:alarm:test-alarm",
    identifier: "test-alarm",
  },
  {
    name: "SecretsManager Secret",
    arn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:test-secret-AbC",
    identifier: "test-secret-AbC",
  },
  {
    name: "EC2 InternetGateway",
    arn: "arn:aws:ec2:us-east-1:123456789012:internet-gateway/igw-abc",
    identifier: "igw-abc",
  },
  {
    name: "EC2 RouteTable",
    arn: "arn:aws:ec2:us-east-1:123456789012:route-table/rtb-abc",
    identifier: "rtb-abc",
  },
  {
    name: "EC2 NatGateway",
    arn: "arn:aws:ec2:us-east-1:123456789012:natgateway/nat-abc",
    identifier: "nat-abc",
  },
  {
    name: "ApiGatewayV2 Api",
    arn: "arn:aws:apigateway:us-east-1::/apis/api-123",
    identifier: "api-123",
  },
];

describe("destroy_resource success for all resource types (Story E2E.2 AC1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // P0-1 fix: destroy_resource now requires explicit operator
    // credentials instead of the host default chain. Provide
    // realistic-shaped env vars so every fixture exercises the
    // full tag-verified delete path.
    process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
    process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] =
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
  });

  for (const fixture of DESTROY_FIXTURES) {
    it(`destroys ${fixture.name} by ARN (${fixture.arn})`, async () => {
      mockTagResolution(fixture.arn);
      mockDeleteSuccess();

      const client = await createTestClient();
      const result = await client.callTool({
        name: "destroy_resource",
        arguments: { resource_identifier: fixture.arn, confirmed: true },
      });

      expect(result.isError).toBeFalsy();
      const body = parseResult(result);
      expect(body.status).toBe("SUCCESS");
      expect(body.resource.arn).toBe(fixture.arn);
    });
  }

  it("returns PENDING_CONFIRMATION when confirmed=false", async () => {
    mockTagResolution("arn:aws:s3:::test-bucket");
    const client = await createTestClient();

    const result = await client.callTool({
      name: "destroy_resource",
      arguments: {
        resource_identifier: "arn:aws:s3:::test-bucket",
        confirmed: false,
      },
    });

    expect(result.isError).toBeFalsy();
    const body = parseResult(result);
    expect(body.status).toBe("PENDING_CONFIRMATION");
    expect(body.resource.arn).toBe("arn:aws:s3:::test-bucket");
  });

  it("returns error when resource not found", async () => {
    // Use mockResolvedValue (not Once) since resolveResource retries 3 times
    mockTaggingSend.mockResolvedValue({
      ResourceTagMappingList: [],
      PaginationToken: undefined,
    });

    const client = await createTestClient();
    const result = await client.callTool({
      name: "destroy_resource",
      arguments: { resource_identifier: "nonexistent", confirmed: true },
    });

    expect(result.isError).toBe(true);
    const body = parseResult(result);
    expect(body.message).toContain("No managed resource found");
    // Generous timeout: the resolver does MAX_RESOLVE_RETRIES (4) attempts
    // × RESOLVE_RETRY_DELAY_MS (5s) of real-timer sleep between attempts,
    // so this test takes ~15s in isolation and is borderline under heavy
    // parallel load. Bumped to 60s to absorb full-suite contention.
    // (Assertion above is unchanged.)
  }, 60000);

  it("returns error when delete operation fails", async () => {
    mockTagResolution("arn:aws:s3:::test-bucket");
    // DeleteResource returns token
    mockCCSend.mockResolvedValueOnce({
      ProgressEvent: { RequestToken: "token", OperationStatus: "IN_PROGRESS" },
    });
    // Poll returns FAILED
    mockCCSend.mockResolvedValueOnce({
      ProgressEvent: {
        OperationStatus: "FAILED",
        StatusMessage: "Access denied",
      },
    });

    const client = await createTestClient();
    const result = await client.callTool({
      name: "destroy_resource",
      arguments: {
        resource_identifier: "arn:aws:s3:::test-bucket",
        confirmed: true,
      },
    });

    expect(result.isError).toBe(true);
    const body = parseResult(result);
    expect(body.message).toContain("Destroy failed");
  });
});

/**
 * Tests for destroy-service.ts — ALB post-delete ENI drain.
 *
 * Split from destroy-service.test.ts (Wave 3 F9 P2-6). ALB leaves orphan
 * ENIs in the VPC after CCAPI reports SUCCESS; destroy-service polls for
 * them and detaches before returning. This file covers the post-delete
 * drain loop — transient errors must NOT fail the destroy because the ALB
 * itself is already gone.
 *
 * @see Story 36.1
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
import { MissingAssigneeCredentialsError } from "@assignee/core";
import { requireAssigneeCredentials } from "../../config/aws-credentials.js";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────
// A6  (2026-04-08): mockDeleteEventSourceMapping and mockDeleteTopic were
//                   removed after Lambda ESM and SNS Topic delete were
//                   migrated from SDK fallback to CCAPI. Both types now go
//                   through mockDeleteResource.
// A10 (2026-04-09): mockUnsubscribe was removed after SNS::Subscription was
//                   promoted to first-class; destroy now routes through
//                   mockDeleteResource too.
const {
  mockDeleteResource,
  mockGetRequestStatus,
  mockCfSend,
  mockDdbSend,
  mockS3Send,
  mockEc2Send,
} = vi.hoisted(() => ({
  mockDeleteResource: vi.fn(),
  mockGetRequestStatus: vi.fn(),
  mockCfSend: vi.fn(),
  mockDdbSend: vi.fn(),
  mockS3Send: vi.fn(),
  mockEc2Send: vi.fn(),
}));

// NOTE: Plain functions/classes (not vi.fn) so impls survive vitest's
// mockReset:true between tests.

// ── Mock operator credentials ─────────────────────────────────────────────────
vi.mock("../../config/operator-credentials.js", () => ({
  operatorCredentials: () => ({
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
  }),
}));

// ── Mock resolve-arn (Wave 11 P2-2 cross-account guard) ─────────────────
// classifyNotFoundShortCircuit dynamic-imports getOperatorAccountId from
// resolve-arn.js when a CCAPI NotFound fires. The default mock returns
// undefined so existing tests get the legacy behavior (NotFound treated
// as success regardless of cross-account threat). Cross-account tests
// override this via mockGetOperatorAccountId.mockResolvedValueOnce.
const { mockGetOperatorAccountId } = vi.hoisted(() => ({
  mockGetOperatorAccountId: vi.fn<() => Promise<string | undefined>>(),
}));
vi.mock("../../utils/resolve-arn.js", () => ({
  getOperatorAccountId: mockGetOperatorAccountId,
  resolveResourceArn: vi.fn(),
  resetAccountIdCache: vi.fn(),
}));

// ── Mock CloudControlAdapter ──────────────────────────────────────────────────
vi.mock("../cloudcontrol-adapter.js", () => {
  class CloudControlAdapter {
    deleteResource = mockDeleteResource;
    getRequestStatus = mockGetRequestStatus;
  }
  return { CloudControlAdapter };
});

// ── Mock createCloudControlClient ─────────────────────────────────────────────
vi.mock("../cloudcontrol-client.js", () => ({
  createCloudControlClient: () => ({}),
}));

// ── Mock SDKFallbackDispatcher ────────────────────────────────────────────────
// A10 (2026-04-09): after SNS Subscription promotion the dispatcher is a
// redirect-only classifier with no SDK write paths. destroy-service no
// longer constructs the dispatcher at all, but keeping a trivial mock
// here guarantees any future regression that re-introduces a dispatcher
// import surfaces immediately.
vi.mock("../sdk-fallback-dispatcher.js", () => {
  class SDKFallbackDispatcher {
    canHandle = () => false;
    canDelete = () => false;
    isRedirect = () => null;
  }
  return { SDKFallbackDispatcher };
});

// ── Mock @aws-sdk/client-cloudfront ───────────────────────────────────────────
vi.mock("@aws-sdk/client-cloudfront", () => {
  class MockCloudFrontClient {
    send = mockCfSend;
  }
  function GetDistributionCommand(input: Record<string, unknown>) {
    return { _type: "GetDistribution", ...input };
  }
  function UpdateDistributionCommand(input: Record<string, unknown>) {
    return { _type: "UpdateDistribution", ...input };
  }
  function DeleteDistributionCommand(input: Record<string, unknown>) {
    return { _type: "DeleteDistribution", ...input };
  }
  return {
    CloudFrontClient: MockCloudFrontClient,
    GetDistributionCommand,
    UpdateDistributionCommand,
    DeleteDistributionCommand,
  };
});

// ── Mock @aws-sdk/client-dynamodb ─────────────────────────────────────────────
vi.mock("@aws-sdk/client-dynamodb", () => {
  class MockDynamoDBClient {
    send = mockDdbSend;
  }
  function UpdateTableCommand(input: Record<string, unknown>) {
    return { _type: "UpdateTable", ...input };
  }
  function DescribeTableCommand(input: Record<string, unknown>) {
    return { _type: "DescribeTable", ...input };
  }
  return {
    DynamoDBClient: MockDynamoDBClient,
    UpdateTableCommand,
    DescribeTableCommand,
  };
});

// ── Mock @aws-sdk/client-s3 ───────────────────────────────────────────────────
vi.mock("@aws-sdk/client-s3", () => {
  class MockS3Client {
    send = mockS3Send;
  }
  function ListObjectVersionsCommand(input: Record<string, unknown>) {
    return { _type: "ListObjectVersions", ...input };
  }
  function DeleteObjectsCommand(input: Record<string, unknown>) {
    return { _type: "DeleteObjects", ...input };
  }
  return {
    S3Client: MockS3Client,
    ListObjectVersionsCommand,
    DeleteObjectsCommand,
  };
});

// ── Mock @aws-sdk/client-ec2 ──────────────────────────────────────────────────
vi.mock("@aws-sdk/client-ec2", () => {
  class MockEC2Client {
    send = mockEc2Send;
  }
  function DescribeInternetGatewaysCommand(input: Record<string, unknown>) {
    return { _type: "DescribeInternetGateways", ...input };
  }
  function DetachInternetGatewayCommand(input: Record<string, unknown>) {
    return { _type: "DetachInternetGateway", ...input };
  }
  function DescribeRouteTablesCommand(input: Record<string, unknown>) {
    return { _type: "DescribeRouteTables", ...input };
  }
  function DisassociateRouteTableCommand(input: Record<string, unknown>) {
    return { _type: "DisassociateRouteTable", ...input };
  }
  function DescribeNetworkInterfacesCommand(input: Record<string, unknown>) {
    return { _type: "DescribeNetworkInterfaces", ...input };
  }
  return {
    EC2Client: MockEC2Client,
    DescribeInternetGatewaysCommand,
    DetachInternetGatewayCommand,
    DescribeRouteTablesCommand,
    DisassociateRouteTableCommand,
    DescribeNetworkInterfacesCommand,
  };
});

// ── Import after mocks ────────────────────────────────────────────────────────
import { destroySingleResource } from "../destroy-service.js";

// Stub global setTimeout to resolve immediately — avoids real timer waits in
// pollDeleteStatus and the CloudFront disable-then-delete polling loop.
const originalSetTimeout = globalThis.setTimeout;
const ORIGINAL_ENV = { ...process.env };
beforeEach(() => {
  vi.clearAllMocks();
  // Default: operator account is undefined → classifyNotFoundShortCircuit
  // returns "safe-shortcircuit" → NotFound treated as success (the legacy
  // Wave 5 behavior). Specific cross-account tests override this via
  // mockGetOperatorAccountId.mockResolvedValueOnce. Must be set AFTER
  // clearAllMocks or the default would be wiped.
  mockGetOperatorAccountId.mockResolvedValue(undefined);
  // @ts-expect-error — simplified stub for test purposes
  globalThis.setTimeout = (fn: () => void) => originalSetTimeout(fn, 0);
  // destroy-service now uses requireAssigneeCredentials("operator") for the
  // DynamoDB and S3 pre-delete hooks. Provide realistic-shaped credentials
  // so the hooks construct their SDK clients and exercise the mocked send().
  process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
  process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] =
    "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
});
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});
afterAll(() => {
  globalThis.setTimeout = originalSetTimeout;
});

describe("destroySingleResource", () => {
  describe("ALB post-delete ENI drain", () => {
    const ALB_ARN =
      "arn:aws:elasticloadbalancing:us-east-1:054125018476:loadbalancer/app/assignee-alb-test/abc123def456";

    it("polls DescribeNetworkInterfaces until ALB ENIs are gone", async () => {
      // CCAPI delete succeeds
      mockDeleteResource.mockResolvedValue([null, { requestToken: "tok-alb" }]);
      mockGetRequestStatus.mockResolvedValue([
        null,
        { operationStatus: "SUCCESS" },
      ]);

      // First poll: 1 ENI still present
      mockEc2Send.mockResolvedValueOnce({
        NetworkInterfaces: [
          {
            NetworkInterfaceId: "eni-0abc123",
            Description: "ELB app/assignee-alb-test/abc123def456",
          },
        ],
      });
      // Second poll: ENIs gone
      mockEc2Send.mockResolvedValueOnce({
        NetworkInterfaces: [],
      });

      const result = await destroySingleResource({
        arn: ALB_ARN,
        resourceType: "AWS::ElasticLoadBalancingV2::LoadBalancer",
        identifier: ALB_ARN,
        region: "us-east-1",
      });

      expect(result.success).toBe(true);
      // Should have called DescribeNetworkInterfaces twice
      const eniCalls = mockEc2Send.mock.calls.filter(
        (c) =>
          (c[0] as { _type: string })._type === "DescribeNetworkInterfaces",
      );
      expect(eniCalls).toHaveLength(2);
    });

    it("succeeds even if ENI drain polling fails (non-fatal)", async () => {
      mockDeleteResource.mockResolvedValue([
        null,
        { requestToken: "tok-alb2" },
      ]);
      mockGetRequestStatus.mockResolvedValue([
        null,
        { operationStatus: "SUCCESS" },
      ]);

      // ENI poll throws
      mockEc2Send.mockRejectedValueOnce(new Error("RequestLimitExceeded"));

      const result = await destroySingleResource({
        arn: ALB_ARN,
        resourceType: "AWS::ElasticLoadBalancingV2::LoadBalancer",
        identifier: ALB_ARN,
        region: "us-east-1",
      });

      // Delete still reported as success — ENI drain is non-fatal
      expect(result.success).toBe(true);
    });

    it("skips ENI drain immediately when no ENIs are present", async () => {
      mockDeleteResource.mockResolvedValue([
        null,
        { requestToken: "tok-alb3" },
      ]);
      mockGetRequestStatus.mockResolvedValue([
        null,
        { operationStatus: "SUCCESS" },
      ]);

      // No ENIs from the start
      mockEc2Send.mockResolvedValueOnce({
        NetworkInterfaces: [],
      });

      const result = await destroySingleResource({
        arn: ALB_ARN,
        resourceType: "AWS::ElasticLoadBalancingV2::LoadBalancer",
        identifier: ALB_ARN,
        region: "us-east-1",
      });

      expect(result.success).toBe(true);
      const eniCalls = mockEc2Send.mock.calls.filter(
        (c) =>
          (c[0] as { _type: string })._type === "DescribeNetworkInterfaces",
      );
      expect(eniCalls).toHaveLength(1);
    });

    it("returns MissingAssigneeCredentialsError as non-fatal when creds are missing", async () => {
      // Clear the env vars that provide operator credentials
      delete process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"];
      delete process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"];

      mockDeleteResource.mockResolvedValue([
        null,
        { requestToken: "tok-alb4" },
      ]);
      mockGetRequestStatus.mockResolvedValue([
        null,
        { operationStatus: "SUCCESS" },
      ]);

      const result = await destroySingleResource({
        arn: ALB_ARN,
        resourceType: "AWS::ElasticLoadBalancingV2::LoadBalancer",
        identifier: ALB_ARN,
        region: "us-east-1",
      });

      // Delete still succeeds — ENI drain is non-fatal
      expect(result.success).toBe(true);
    });
  });
});

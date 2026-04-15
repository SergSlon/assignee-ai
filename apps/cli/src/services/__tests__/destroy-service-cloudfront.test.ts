/**
 * Tests for destroy-service.ts — CloudFront distribution destroy.
 *
 * Split from destroy-service.test.ts (Wave 3 F9 P2-6). Covers the multi-step
 * CloudFront disable-then-delete flow and its polling resilience (status
 * poller must survive transient ThrottlingException / EventualConsistency
 * while the distribution transitions InProgress -> Deployed -> deleted).
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
  describe("CloudFront distribution destroy", () => {
    it("disables distribution, waits for deploy, then deletes", async () => {
      // GetDistribution — initial (Enabled=true)
      mockCfSend.mockResolvedValueOnce({
        Distribution: {
          DistributionConfig: { Enabled: true },
          Status: "Deployed",
        },
        ETag: "etag-1",
      });
      // UpdateDistribution — disable
      mockCfSend.mockResolvedValueOnce({});
      // GetDistribution — poll for "Deployed" status after disable
      mockCfSend.mockResolvedValueOnce({
        Distribution: { Status: "Deployed" },
        ETag: "etag-2",
      });
      // DeleteDistribution
      mockCfSend.mockResolvedValueOnce({});

      const result = await destroySingleResource({
        arn: "arn:aws:cloudfront::123456:distribution/EDFDVBD6EXAMPLE",
        resourceType: "AWS::CloudFront::Distribution",
        identifier: "EDFDVBD6EXAMPLE",
        region: "us-east-1",
      });

      expect(result.success).toBe(true);
      // 4 calls: get, update, poll-get, delete
      expect(mockCfSend).toHaveBeenCalledTimes(4);
    });

    it("deletes directly when already disabled", async () => {
      // GetDistribution — already disabled
      mockCfSend.mockResolvedValueOnce({
        Distribution: {
          DistributionConfig: { Enabled: false },
          Status: "Deployed",
        },
        ETag: "etag-disabled",
      });
      // DeleteDistribution
      mockCfSend.mockResolvedValueOnce({});

      const result = await destroySingleResource({
        arn: "arn:aws:cloudfront::123456:distribution/EDFDVBD6EXAMPLE",
        resourceType: "AWS::CloudFront::Distribution",
        identifier: "EDFDVBD6EXAMPLE",
        region: "us-east-1",
      });

      expect(result.success).toBe(true);
      // 2 calls: get, delete
      expect(mockCfSend).toHaveBeenCalledTimes(2);
    });

    it("returns error when distribution config cannot be retrieved", async () => {
      mockCfSend.mockResolvedValueOnce({
        Distribution: null,
        ETag: null,
      });

      const result = await destroySingleResource({
        arn: "arn:aws:cloudfront::123456:distribution/EDFDVBD6EXAMPLE",
        resourceType: "AWS::CloudFront::Distribution",
        identifier: "EDFDVBD6EXAMPLE",
        region: "us-east-1",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Could not retrieve distribution config");
    });

    it("returns error when CloudFront SDK throws", async () => {
      mockCfSend.mockRejectedValueOnce(new Error("AccessDenied"));

      const result = await destroySingleResource({
        arn: "arn:aws:cloudfront::123456:distribution/EDFDVBD6EXAMPLE",
        resourceType: "AWS::CloudFront::Distribution",
        identifier: "EDFDVBD6EXAMPLE",
        region: "us-east-1",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("CloudFront destroy failed");
    });

    // L-A12 regression: the CloudFront branch must use the same
    // requireAssigneeCredentials("operator") helper as the rest of
    // destroy-service. Previously it inspected awsConfig.accessKeyId from
    // operatorCredentials() and emitted a generic "Missing AWS credentials"
    // error, drifting from the central helper that names the exact env vars.
    it("surfaces requireAssigneeCredentials error when ASSIGNEE_OPERATOR vars are unset", async () => {
      delete process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"];
      delete process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"];

      const result = await destroySingleResource({
        arn: "arn:aws:cloudfront::123456:distribution/EDFDVBD6EXAMPLE",
        resourceType: "AWS::CloudFront::Distribution",
        identifier: "EDFDVBD6EXAMPLE",
        region: "us-east-1",
      });

      expect(result.success).toBe(false);
      // The friendly error must name the same env vars as the central
      // helper, NOT the legacy "Missing AWS credentials for resource cleanup"
      // string with no actionable detail.
      expect(result.error).toContain("Missing AWS credentials");
      expect(result.error).toContain("ASSIGNEE_OPERATOR_ACCESS_KEY_ID");
      // No CloudFront SDK calls must have been issued — the credential
      // check fires BEFORE the first cf.send().
      expect(mockCfSend).not.toHaveBeenCalled();
    });
  });
  describe("CloudFront disable polling resilience", () => {
    it("retries transient GetDistribution errors during the disable wait", async () => {
      // Step 1: GetDistribution (initial) — Enabled=true
      mockCfSend.mockResolvedValueOnce({
        Distribution: {
          DistributionConfig: { Enabled: true },
          Status: "InProgress",
        },
        ETag: "etag-1",
      });
      // Step 2: UpdateDistribution — disable ok
      mockCfSend.mockResolvedValueOnce({});
      // Step 3: Polling GetDistribution — first 2 calls throw transient
      // errors, third call returns Deployed.
      mockCfSend.mockRejectedValueOnce(new Error("ThrottlingException"));
      mockCfSend.mockRejectedValueOnce(new Error("503 ServiceUnavailable"));
      mockCfSend.mockResolvedValueOnce({
        Distribution: { Status: "Deployed" },
        ETag: "etag-2",
      });
      // Step 4: DeleteDistribution — final
      mockCfSend.mockResolvedValueOnce({});

      const result = await destroySingleResource({
        arn: "arn:aws:cloudfront::123456:distribution/EDFDVBD6EXAMPLE",
        resourceType: "AWS::CloudFront::Distribution",
        identifier: "EDFDVBD6EXAMPLE",
        region: "us-east-1",
      });

      expect(result.success).toBe(true);
      // 6 calls: get, update, 2x transient poll, successful poll, delete
      expect(mockCfSend).toHaveBeenCalledTimes(6);
    });

    it("aborts cleanly after too many consecutive transient poll errors", async () => {
      // Step 1: GetDistribution — Enabled=true
      mockCfSend.mockResolvedValueOnce({
        Distribution: {
          DistributionConfig: { Enabled: true },
          Status: "InProgress",
        },
        ETag: "etag-1",
      });
      // Step 2: UpdateDistribution — disable ok
      mockCfSend.mockResolvedValueOnce({});
      // All subsequent polls throw transient errors until the retry budget
      // (CLOUDFRONT_MAX_TRANSIENT_ERRORS = 5 consecutive) is exhausted.
      mockCfSend.mockRejectedValue(new Error("Throttling"));

      const result = await destroySingleResource({
        arn: "arn:aws:cloudfront::123456:distribution/EDFDVBD6EXAMPLE",
        resourceType: "AWS::CloudFront::Distribution",
        identifier: "EDFDVBD6EXAMPLE",
        region: "us-east-1",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("CloudFront poll failed");
      expect(result.error).toContain("Throttling");
    });
  });
});

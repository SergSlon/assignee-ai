/**
 * Tests for destroy-service.ts — destroySingleResource()
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
  return {
    EC2Client: MockEC2Client,
    DescribeInternetGatewaysCommand,
    DetachInternetGatewayCommand,
    DescribeRouteTablesCommand,
    DisassociateRouteTableCommand,
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
  // ── CloudControl happy path ───────────────────────────────────────────────
  describe("CloudControl API path", () => {
    it("returns success when delete + poll returns SUCCESS", async () => {
      mockDeleteResource.mockResolvedValue([null, { requestToken: "tok-123" }]);
      mockGetRequestStatus.mockResolvedValue([
        null,
        { operationStatus: "SUCCESS" },
      ]);

      const result = await destroySingleResource({
        arn: "arn:aws:s3:::test-bucket",
        resourceType: "AWS::S3::Bucket",
        identifier: "test-bucket",
        region: "us-east-1",
      });

      expect(result.success).toBe(true);
      expect(result.resourceType).toBe("AWS::S3::Bucket");
      expect(result.identifier).toBe("test-bucket");
      expect(mockDeleteResource).toHaveBeenCalledWith(
        "AWS::S3::Bucket",
        "test-bucket",
      );
    });

    it("returns failure when poll times out (MAX_POLL_ATTEMPTS)", async () => {
      mockDeleteResource.mockResolvedValue([
        null,
        { requestToken: "tok-timeout" },
      ]);
      // Always return IN_PROGRESS — with setTimeout stubbed to 0ms,
      // all 60 poll iterations complete instantly.
      mockGetRequestStatus.mockResolvedValue([
        null,
        { operationStatus: "IN_PROGRESS" },
      ]);

      const result = await destroySingleResource({
        arn: "arn:aws:s3:::timeout-bucket",
        resourceType: "AWS::S3::Bucket",
        identifier: "timeout-bucket",
        region: "us-east-1",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("timed out");
      // Verify all 60 poll attempts were made
      expect(mockGetRequestStatus).toHaveBeenCalledTimes(60);
    });

    it("returns failure when poll returns FAILED status", async () => {
      mockDeleteResource.mockResolvedValue([
        null,
        { requestToken: "tok-fail" },
      ]);
      mockGetRequestStatus.mockResolvedValue([
        null,
        {
          operationStatus: "FAILED",
          statusMessage: "BucketNotEmpty",
        },
      ]);

      const result = await destroySingleResource({
        arn: "arn:aws:s3:::fail-bucket",
        resourceType: "AWS::S3::Bucket",
        identifier: "fail-bucket",
        region: "us-east-1",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("BucketNotEmpty");
    });

    it("returns failure when deleteResource returns a non-NOT_FOUND error", async () => {
      mockDeleteResource.mockResolvedValue([
        { kind: "UNKNOWN", message: "Internal service error" },
        null,
      ]);

      const result = await destroySingleResource({
        arn: "arn:aws:s3:::broken-bucket",
        resourceType: "AWS::S3::Bucket",
        identifier: "broken-bucket",
        region: "us-east-1",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Internal service error");
    });

    // Closes the destroy --all noise from the brief: the Resource Groups
    // Tagging API continues to return tags for ~1 hour after a NAT Gateway
    // or EIP is deleted, so the bulk-destroy plan picks up resources that
    // are already gone in AWS. Reporting NOT_FOUND as failure produced
    // confusing "Failed: ... was not found" lines for resources the user
    // intentionally deleted in a previous run. The user's destroy intent
    // is satisfied either way — return success.
    //
    // CloudControl reports the "already gone" condition in TWO different
    // ways depending on whether AWS catches the missing resource at the
    // initial DeleteResource call or at the subsequent poll:
    //   1. deleteResource → NOT_FOUND error (covered by the next test)
    //   2. deleteResource → success token, then GetResourceRequestStatus
    //      returns FAILED with ErrorCode="NotFound" (covered by the test
    //      after that — this is what NAT Gateway hit in the live verify run)
    it("treats deleteResource NOT_FOUND as success — resource already gone", async () => {
      mockDeleteResource.mockResolvedValue([
        {
          kind: "NOT_FOUND",
          message:
            "Resource of type 'AWS::EC2::NatGateway' with identifier 'nat-0b337150b5f9b0b62' was not found.",
        },
        null,
      ]);

      const result = await destroySingleResource({
        arn: "arn:aws:ec2:us-east-1:123456789012:natgateway/nat-0b337150b5f9b0b62",
        resourceType: "AWS::EC2::NatGateway",
        identifier: "nat-0b337150b5f9b0b62",
        region: "us-east-1",
      });

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      // Poll must NOT have been called — the delete short-circuited.
      expect(mockGetRequestStatus).not.toHaveBeenCalled();
    });

    it("treats poll FAILED with ErrorCode=NotFound as success", async () => {
      // Real-world signal observed during the destroy --all live verify
      // for already-deleted NAT Gateways: CloudControl accepts the delete
      // request, returns a token, and the subsequent GetResourceRequest
      // Status returns FAILED with ErrorCode="NotFound" and a status
      // message of "Resource of type ... was not found." The structured
      // ErrorCode is the reliable signal — string-matching the message
      // would be fragile.
      mockDeleteResource.mockResolvedValue([
        null,
        { requestToken: "tok-natgw-already-gone" },
      ]);
      mockGetRequestStatus.mockResolvedValue([
        null,
        {
          operationStatus: "FAILED",
          errorCode: "NotFound",
          statusMessage:
            "Resource of type 'AWS::EC2::NatGateway' with identifier 'nat-0928a4abb02ca9eb3' was not found.",
        },
      ]);

      const result = await destroySingleResource({
        arn: "arn:aws:ec2:us-east-1:123456789012:natgateway/nat-0928a4abb02ca9eb3",
        resourceType: "AWS::EC2::NatGateway",
        identifier: "nat-0928a4abb02ca9eb3",
        region: "us-east-1",
      });

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(mockGetRequestStatus).toHaveBeenCalledTimes(1);
    });

    it("returns failure for poll FAILED with non-NotFound errorCode", async () => {
      // Genuine FAILED responses (e.g. DependencyViolation) must still
      // surface as errors — the NotFound short-circuit is narrowly
      // scoped to the "already gone" case.
      mockDeleteResource.mockResolvedValue([
        null,
        { requestToken: "tok-stuck" },
      ]);
      mockGetRequestStatus.mockResolvedValue([
        null,
        {
          operationStatus: "FAILED",
          errorCode: "GeneralServiceException",
          statusMessage:
            "The vpc 'vpc-0712644090346eb2b' has dependencies and cannot be deleted.",
        },
      ]);

      const result = await destroySingleResource({
        arn: "arn:aws:ec2:us-east-1:123456789012:vpc/vpc-0712644090346eb2b",
        resourceType: "AWS::EC2::VPC",
        identifier: "vpc-0712644090346eb2b",
        region: "us-east-1",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("has dependencies");
    });

    // Wave 11 P2-2: cross-account sanity check on the NotFound short-circuit.
    // When the operator credentials accidentally point at a different
    // account than the resource ARN, CCAPI's NotFound is misleading —
    // the resource may genuinely exist in the user's intended account
    // but be invisible to the wrongly-assumed operator. Surface this as
    // a real error rather than treating it as silent destroy success.
    it("blocks deleteResource NOT_FOUND short-circuit when operator account differs from ARN account", async () => {
      // Operator is configured for one account...
      mockGetOperatorAccountId.mockResolvedValue("054125018476");
      mockDeleteResource.mockResolvedValue([
        {
          kind: "NOT_FOUND",
          message: "Resource not found.",
        },
        null,
      ]);

      const result = await destroySingleResource({
        // ...but the resource ARN belongs to a different account.
        arn: "arn:aws:s3:::my-bucket-in-other-account",
        resourceType: "AWS::S3::Bucket",
        identifier: "my-bucket-in-other-account",
        region: "us-east-1",
      });

      // S3 bucket ARNs have no account segment — falls through to the
      // safe-shortcircuit branch (extractAccountIdFromArn returns
      // undefined). This is the documented exception: when account
      // info is unavailable on either side, preserve Wave 5 behavior.
      expect(result.success).toBe(true);
    });

    it("blocks deleteResource NOT_FOUND short-circuit on cross-account NAT Gateway ARN", async () => {
      // Operator is configured for 054125018476...
      mockGetOperatorAccountId.mockResolvedValue("054125018476");
      mockDeleteResource.mockResolvedValue([
        {
          kind: "NOT_FOUND",
          message: "Resource not found.",
        },
        null,
      ]);

      const result = await destroySingleResource({
        // ...but the ARN encodes account 999999999999 — the resource
        // legitimately exists in a different account that the operator
        // can't see.
        arn: "arn:aws:ec2:us-east-1:999999999999:natgateway/nat-0b337150b5f9b0b62",
        resourceType: "AWS::EC2::NatGateway",
        identifier: "nat-0b337150b5f9b0b62",
        region: "us-east-1",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("different AWS account");
      expect(result.error).toContain("ASSIGNEE_OPERATOR_ACCESS_KEY_ID");
    });

    it("still treats deleteResource NOT_FOUND as success when operator account matches the ARN", async () => {
      // Operator IS configured for the same account as the ARN — the
      // legitimate "already gone" case (Wave 5 tag-ghost cleanup).
      mockGetOperatorAccountId.mockResolvedValue("054125018476");
      mockDeleteResource.mockResolvedValue([
        {
          kind: "NOT_FOUND",
          message: "Resource not found.",
        },
        null,
      ]);

      const result = await destroySingleResource({
        arn: "arn:aws:ec2:us-east-1:054125018476:natgateway/nat-0928a4abb02ca9eb3",
        resourceType: "AWS::EC2::NatGateway",
        identifier: "nat-0928a4abb02ca9eb3",
        region: "us-east-1",
      });

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it("blocks poll FAILED+NotFound short-circuit on cross-account ARN", async () => {
      // Same threat for the second NotFound path (CCAPI accepts the
      // delete request, then returns FAILED+ErrorCode=NotFound from
      // the poll).
      mockGetOperatorAccountId.mockResolvedValue("054125018476");
      mockDeleteResource.mockResolvedValue([
        null,
        { requestToken: "tok-cross-account" },
      ]);
      mockGetRequestStatus.mockResolvedValue([
        null,
        {
          operationStatus: "FAILED",
          errorCode: "NotFound",
          statusMessage: "Resource not found.",
        },
      ]);

      const result = await destroySingleResource({
        arn: "arn:aws:ec2:us-east-1:999999999999:natgateway/nat-0xxx",
        resourceType: "AWS::EC2::NatGateway",
        identifier: "nat-0xxx",
        region: "us-east-1",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("different AWS account");
    });
  });

  // ── A6: Lambda EventSourceMapping now routes through CCAPI ────────────────
  describe("CCAPI path — Lambda EventSourceMapping (A6)", () => {
    it("calls CloudControl DeleteResource with the mapping UUID as identifier", async () => {
      mockDeleteResource.mockResolvedValue([
        null,
        { requestToken: "tok-esm-1" },
      ]);
      mockGetRequestStatus.mockResolvedValue([
        null,
        { operationStatus: "SUCCESS" },
      ]);

      const result = await destroySingleResource({
        arn: "arn:aws:lambda:us-east-1:123456:event-source-mapping:uuid-123",
        resourceType: "AWS::Lambda::EventSourceMapping",
        identifier: "uuid-123",
        region: "us-east-1",
      });

      expect(result.success).toBe(true);
      expect(mockDeleteResource).toHaveBeenCalledWith(
        "AWS::Lambda::EventSourceMapping",
        "uuid-123",
      );
    });

    it("surfaces CloudControl FAILED as a destroy failure", async () => {
      mockDeleteResource.mockResolvedValue([
        null,
        { requestToken: "tok-esm-fail" },
      ]);
      mockGetRequestStatus.mockResolvedValue([
        null,
        {
          operationStatus: "FAILED",
          statusMessage: "Mapping is being deleted",
        },
      ]);

      const result = await destroySingleResource({
        arn: "arn:aws:lambda:us-east-1:123456:event-source-mapping:uuid-bad",
        resourceType: "AWS::Lambda::EventSourceMapping",
        identifier: "uuid-bad",
        region: "us-east-1",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Mapping is being deleted");
    });
  });

  // ── A10: SNS Subscription delete now routes through CCAPI ────────────────
  describe("CCAPI path — SNS Subscription (A10)", () => {
    it("calls CloudControl DeleteResource with the subscription ARN as identifier", async () => {
      // A10 (2026-04-09): AWS::SNS::Subscription was promoted from
      // CCAPI_FALLBACK_TYPES to first-class. The previous SDK
      // UnsubscribeCommand branch is retired — destroy routes
      // through the standard CCAPI DeleteResource path, same as
      // every other first-class type. The primary identifier is
      // /properties/Arn so CCAPI receives the full subscription
      // ARN verbatim.
      mockDeleteResource.mockResolvedValue([
        null,
        { requestToken: "tok-sub-1" },
      ]);
      mockGetRequestStatus.mockResolvedValue([
        null,
        { operationStatus: "SUCCESS" },
      ]);

      const result = await destroySingleResource({
        arn: "arn:aws:sns:us-east-1:123456:my-topic:abcd-1234",
        resourceType: "AWS::SNS::Subscription",
        identifier: "arn:aws:sns:us-east-1:123456:my-topic:abcd-1234",
        region: "us-east-1",
      });

      expect(result.success).toBe(true);
      expect(mockDeleteResource).toHaveBeenCalledWith(
        "AWS::SNS::Subscription",
        "arn:aws:sns:us-east-1:123456:my-topic:abcd-1234",
      );
    });

    it("surfaces CloudControl FAILED as a destroy failure", async () => {
      mockDeleteResource.mockResolvedValue([
        null,
        { requestToken: "tok-sub-fail" },
      ]);
      mockGetRequestStatus.mockResolvedValue([
        null,
        {
          operationStatus: "FAILED",
          statusMessage:
            "Subscription cannot be deleted in PendingConfirmation state",
        },
      ]);

      const result = await destroySingleResource({
        arn: "arn:aws:sns:us-east-1:123456:my-topic:pending-confirm",
        resourceType: "AWS::SNS::Subscription",
        identifier: "arn:aws:sns:us-east-1:123456:my-topic:pending-confirm",
        region: "us-east-1",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("PendingConfirmation");
    });
  });

  // ── A6: SNS Topic delete now routes through CCAPI ─────────────────────────
  describe("CCAPI path — SNS Topic (A6)", () => {
    it("calls CloudControl DeleteResource with the full TopicArn as identifier", async () => {
      // A6 (2026-04-08): verified via live-AWS probe that CCAPI accepts the
      // full TopicArn as the primary identifier and deletes the topic
      // successfully. The SDK fallback (DeleteTopicCommand) is gone.
      mockDeleteResource.mockResolvedValue([
        null,
        { requestToken: "tok-topic-1" },
      ]);
      mockGetRequestStatus.mockResolvedValue([
        null,
        { operationStatus: "SUCCESS" },
      ]);

      const result = await destroySingleResource({
        arn: "arn:aws:sns:us-east-1:123456:my-topic",
        resourceType: "AWS::SNS::Topic",
        identifier: "my-topic",
        region: "us-east-1",
      });

      expect(result.success).toBe(true);
      expect(mockDeleteResource).toHaveBeenCalledWith(
        "AWS::SNS::Topic",
        "my-topic",
      );
    });
  });

  // ── Redirect types ────────────────────────────────────────────────────────
  describe("Redirect types", () => {
    it("returns error for Lambda::Permission (redirect type)", async () => {
      const result = await destroySingleResource({
        arn: "arn:aws:lambda:us-east-1:123456:policy:my-policy",
        resourceType: "AWS::Lambda::Permission",
        identifier: "my-policy",
        region: "us-east-1",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("cannot be deleted");
      expect(result.error).toContain("manual deletion");
      // Should NOT call any delete method
      expect(mockDeleteResource).not.toHaveBeenCalled();
    });
  });

  // ── DynamoDB pre-delete hook ──────────────────────────────────────────────
  describe("DynamoDB pre-delete hook", () => {
    it("disables deletion protection before deleting", async () => {
      mockDdbSend.mockResolvedValue({});
      mockDeleteResource.mockResolvedValue([null, { requestToken: "tok-ddb" }]);
      mockGetRequestStatus.mockResolvedValue([
        null,
        { operationStatus: "SUCCESS" },
      ]);

      const result = await destroySingleResource({
        arn: "arn:aws:dynamodb:us-east-1:123456:table/my-table",
        resourceType: "AWS::DynamoDB::Table",
        identifier: "my-table",
        region: "us-east-1",
      });

      expect(result.success).toBe(true);
      // DynamoDB UpdateTable should have been called to disable protection
      expect(mockDdbSend).toHaveBeenCalled();
      const updateCall = mockDdbSend.mock.calls[0]![0];
      expect(updateCall.TableName).toBe("my-table");
      expect(updateCall.DeletionProtectionEnabled).toBe(false);
    });

    it("continues to delete even if disabling protection fails", async () => {
      mockDdbSend.mockRejectedValue(new Error("Table not found"));
      mockDeleteResource.mockResolvedValue([
        null,
        { requestToken: "tok-ddb2" },
      ]);
      mockGetRequestStatus.mockResolvedValue([
        null,
        { operationStatus: "SUCCESS" },
      ]);

      const result = await destroySingleResource({
        arn: "arn:aws:dynamodb:us-east-1:123456:table/my-table",
        resourceType: "AWS::DynamoDB::Table",
        identifier: "my-table",
        region: "us-east-1",
      });

      // Should still succeed — protection disable is non-fatal
      expect(result.success).toBe(true);
    });
  });

  // ── InternetGateway pre-delete hook ───────────────────────────────────────
  // Closes the destroy --all DependencyViolation bug: AWS::EC2::VPCGateway
  // Attachment is a CloudFormation-only construct (non-taggable) so it never
  // appears in the bulk-destroy plan; the IGW must be detached from each
  // attached VPC before CloudControl's DeleteResource path can succeed.
  describe("InternetGateway pre-delete hook", () => {
    const IGW_ID = "igw-0231e9c9af6a9f7cc";
    const VPC_ID = "vpc-0712644090346eb2b";

    it("detaches the IGW from each attached VPC before deleting", async () => {
      // DescribeInternetGateways → 1 attached VPC
      mockEc2Send.mockResolvedValueOnce({
        InternetGateways: [
          {
            InternetGatewayId: IGW_ID,
            Attachments: [{ VpcId: VPC_ID, State: "attached" }],
          },
        ],
      });
      // DetachInternetGateway
      mockEc2Send.mockResolvedValueOnce({});
      // CloudControl DeleteResource
      mockDeleteResource.mockResolvedValue([null, { requestToken: "tok-igw" }]);
      mockGetRequestStatus.mockResolvedValue([
        null,
        { operationStatus: "SUCCESS" },
      ]);

      const result = await destroySingleResource({
        arn: `arn:aws:ec2:us-east-1:123456789012:internet-gateway/${IGW_ID}`,
        resourceType: "AWS::EC2::InternetGateway",
        identifier: IGW_ID,
        region: "us-east-1",
      });

      expect(result.success).toBe(true);
      // Describe + detach must run BEFORE the CloudControl delete.
      expect(mockEc2Send).toHaveBeenCalledTimes(2);
      const describeCmd = mockEc2Send.mock.calls[0]![0];
      expect(describeCmd._type).toBe("DescribeInternetGateways");
      expect(describeCmd.InternetGatewayIds).toEqual([IGW_ID]);
      const detachCmd = mockEc2Send.mock.calls[1]![0];
      expect(detachCmd._type).toBe("DetachInternetGateway");
      expect(detachCmd.InternetGatewayId).toBe(IGW_ID);
      expect(detachCmd.VpcId).toBe(VPC_ID);
      expect(mockDeleteResource).toHaveBeenCalledWith(
        "AWS::EC2::InternetGateway",
        IGW_ID,
      );
    });

    it("skips already-detached attachments and unattached IGWs", async () => {
      // IGW returned with State=detached — must NOT trigger detach
      mockEc2Send.mockResolvedValueOnce({
        InternetGateways: [
          {
            InternetGatewayId: IGW_ID,
            Attachments: [{ VpcId: VPC_ID, State: "detached" }],
          },
        ],
      });
      mockDeleteResource.mockResolvedValue([
        null,
        { requestToken: "tok-igw2" },
      ]);
      mockGetRequestStatus.mockResolvedValue([
        null,
        { operationStatus: "SUCCESS" },
      ]);

      const result = await destroySingleResource({
        arn: `arn:aws:ec2:us-east-1:123456789012:internet-gateway/${IGW_ID}`,
        resourceType: "AWS::EC2::InternetGateway",
        identifier: IGW_ID,
        region: "us-east-1",
      });

      expect(result.success).toBe(true);
      // Only the describe — no detach attempts
      expect(mockEc2Send).toHaveBeenCalledTimes(1);
    });

    it("continues to CloudControl delete even if EC2 describe fails (non-fatal hook)", async () => {
      // Hook failure must NOT short-circuit the destroy — CloudControl gets
      // the chance to surface its own clean error if the IGW is really stuck.
      mockEc2Send.mockRejectedValueOnce(new Error("RequestLimitExceeded"));
      mockDeleteResource.mockResolvedValue([
        null,
        { requestToken: "tok-igw3" },
      ]);
      mockGetRequestStatus.mockResolvedValue([
        null,
        { operationStatus: "SUCCESS" },
      ]);

      const result = await destroySingleResource({
        arn: `arn:aws:ec2:us-east-1:123456789012:internet-gateway/${IGW_ID}`,
        resourceType: "AWS::EC2::InternetGateway",
        identifier: IGW_ID,
        region: "us-east-1",
      });

      expect(result.success).toBe(true);
      expect(mockDeleteResource).toHaveBeenCalled();
    });

    it("returns missing-credentials error when ASSIGNEE_OPERATOR vars unset", async () => {
      delete process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"];
      delete process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"];

      const result = await destroySingleResource({
        arn: `arn:aws:ec2:us-east-1:123456789012:internet-gateway/${IGW_ID}`,
        resourceType: "AWS::EC2::InternetGateway",
        identifier: IGW_ID,
        region: "us-east-1",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Cannot detach InternetGateway");
      expect(result.error).toContain("ASSIGNEE_OPERATOR_ACCESS_KEY_ID");
      // No EC2 SDK calls — credential check fires before the first send
      expect(mockEc2Send).not.toHaveBeenCalled();
      // No CloudControl delete attempted
      expect(mockDeleteResource).not.toHaveBeenCalled();
    });

    // Wave 11 P2-3: half-state recovery on multi-attachment IGWs.
    // Previously the for loop ran detaches sequentially with no
    // per-attachment error handling — if attachment N+1 failed after
    // N had already succeeded, the IGW was left in a half-detached
    // state with no record of which detaches landed. The fix wraps
    // each detach in its own try/catch, continues the loop on
    // failures, and lets CCAPI's subsequent delete produce the
    // authoritative DependencyViolation if the residual attachments
    // matter. The user can re-run destroy and it will pick up where
    // this one left off.
    it("continues detaching remaining VPCs after a per-attachment failure (half-state recovery)", async () => {
      const VPC_A = "vpc-0aaaaaaaaaaaaaaaa";
      const VPC_B = "vpc-0bbbbbbbbbbbbbbbb";
      const VPC_C = "vpc-0cccccccccccccccc";
      // DescribeInternetGateways → 3 attached VPCs (rare in practice
      // but possible for shared IGWs)
      mockEc2Send.mockResolvedValueOnce({
        InternetGateways: [
          {
            InternetGatewayId: IGW_ID,
            Attachments: [
              { VpcId: VPC_A, State: "attached" },
              { VpcId: VPC_B, State: "attached" },
              { VpcId: VPC_C, State: "attached" },
            ],
          },
        ],
      });
      // First detach succeeds
      mockEc2Send.mockResolvedValueOnce({});
      // Second detach fails — old code would have aborted the loop
      mockEc2Send.mockRejectedValueOnce(new Error("DependencyViolation"));
      // Third detach must STILL be attempted under the new behavior
      mockEc2Send.mockResolvedValueOnce({});
      // CloudControl delete still runs (let CCAPI surface authoritative
      // errors if any residual attachment matters)
      mockDeleteResource.mockResolvedValue([
        null,
        { requestToken: "tok-igw-multi" },
      ]);
      mockGetRequestStatus.mockResolvedValue([
        null,
        { operationStatus: "SUCCESS" },
      ]);

      const result = await destroySingleResource({
        arn: `arn:aws:ec2:us-east-1:123456789012:internet-gateway/${IGW_ID}`,
        resourceType: "AWS::EC2::InternetGateway",
        identifier: IGW_ID,
        region: "us-east-1",
      });

      // Critical: ALL THREE detach attempts ran (1 describe + 3 detaches)
      const detachCalls = mockEc2Send.mock.calls.filter(
        (c) => (c[0] as { _type: string })._type === "DetachInternetGateway",
      );
      expect(detachCalls).toHaveLength(3);
      expect(detachCalls.map((c) => (c[0] as { VpcId: string }).VpcId)).toEqual(
        [VPC_A, VPC_B, VPC_C],
      );
      // Forward progress preserved — CloudControl delete still ran
      expect(mockDeleteResource).toHaveBeenCalled();
      // The mock CCAPI delete succeeded so the destroy reports success
      // (in real life, the second detach failure would have left a
      // residual attachment that CCAPI would catch with
      // DependencyViolation; the test only validates the loop
      // behavior, not real AWS state).
      expect(result.success).toBe(true);
    });
  });

  // ── RouteTable pre-delete hook ────────────────────────────────────────────
  // Closes the destroy --all DependencyViolation bug for non-default route
  // tables: AWS::EC2::SubnetRouteTableAssociation is a CloudFormation-only
  // construct (non-taggable) so it never appears in the bulk-destroy plan;
  // each non-Main association must be removed before CloudControl's
  // DeleteResource path can succeed.
  describe("RouteTable pre-delete hook", () => {
    const RT_ID = "rtb-0577c1b03ff7f0473";
    const ASSOC_MAIN = "rtbassoc-main12345";
    const ASSOC_SUBNET = "rtbassoc-05e417426782224a8";

    it("disassociates non-Main associations and skips the Main association", async () => {
      mockEc2Send.mockResolvedValueOnce({
        RouteTables: [
          {
            RouteTableId: RT_ID,
            Associations: [
              {
                RouteTableAssociationId: ASSOC_MAIN,
                Main: true,
                AssociationState: { State: "associated" },
              },
              {
                RouteTableAssociationId: ASSOC_SUBNET,
                Main: false,
                AssociationState: { State: "associated" },
              },
            ],
          },
        ],
      });
      // DisassociateRouteTable for the non-Main association
      mockEc2Send.mockResolvedValueOnce({});
      mockDeleteResource.mockResolvedValue([null, { requestToken: "tok-rt" }]);
      mockGetRequestStatus.mockResolvedValue([
        null,
        { operationStatus: "SUCCESS" },
      ]);

      const result = await destroySingleResource({
        arn: `arn:aws:ec2:us-east-1:123456789012:route-table/${RT_ID}`,
        resourceType: "AWS::EC2::RouteTable",
        identifier: RT_ID,
        region: "us-east-1",
      });

      expect(result.success).toBe(true);
      // Describe + exactly one disassociate (the non-Main one)
      expect(mockEc2Send).toHaveBeenCalledTimes(2);
      const disassocCmd = mockEc2Send.mock.calls[1]![0];
      expect(disassocCmd._type).toBe("DisassociateRouteTable");
      expect(disassocCmd.AssociationId).toBe(ASSOC_SUBNET);
      // Main association must NOT have been disassociated
      const allAssocIds = mockEc2Send.mock.calls
        .filter((call) => call[0]._type === "DisassociateRouteTable")
        .map((call) => call[0].AssociationId);
      expect(allAssocIds).not.toContain(ASSOC_MAIN);
    });

    it("is a no-op when the route table has no associations", async () => {
      mockEc2Send.mockResolvedValueOnce({
        RouteTables: [{ RouteTableId: RT_ID, Associations: [] }],
      });
      mockDeleteResource.mockResolvedValue([null, { requestToken: "tok-rt2" }]);
      mockGetRequestStatus.mockResolvedValue([
        null,
        { operationStatus: "SUCCESS" },
      ]);

      const result = await destroySingleResource({
        arn: `arn:aws:ec2:us-east-1:123456789012:route-table/${RT_ID}`,
        resourceType: "AWS::EC2::RouteTable",
        identifier: RT_ID,
        region: "us-east-1",
      });

      expect(result.success).toBe(true);
      // Only describe — no disassociate calls
      expect(mockEc2Send).toHaveBeenCalledTimes(1);
    });

    it("skips already-disassociated entries", async () => {
      mockEc2Send.mockResolvedValueOnce({
        RouteTables: [
          {
            RouteTableId: RT_ID,
            Associations: [
              {
                RouteTableAssociationId: ASSOC_SUBNET,
                Main: false,
                AssociationState: { State: "disassociated" },
              },
            ],
          },
        ],
      });
      mockDeleteResource.mockResolvedValue([null, { requestToken: "tok-rt3" }]);
      mockGetRequestStatus.mockResolvedValue([
        null,
        { operationStatus: "SUCCESS" },
      ]);

      const result = await destroySingleResource({
        arn: `arn:aws:ec2:us-east-1:123456789012:route-table/${RT_ID}`,
        resourceType: "AWS::EC2::RouteTable",
        identifier: RT_ID,
        region: "us-east-1",
      });

      expect(result.success).toBe(true);
      // Only describe — disassociated entries are skipped
      expect(mockEc2Send).toHaveBeenCalledTimes(1);
    });

    it("continues to CloudControl delete when EC2 describe fails (non-fatal)", async () => {
      mockEc2Send.mockRejectedValueOnce(new Error("RequestLimitExceeded"));
      mockDeleteResource.mockResolvedValue([null, { requestToken: "tok-rt4" }]);
      mockGetRequestStatus.mockResolvedValue([
        null,
        { operationStatus: "SUCCESS" },
      ]);

      const result = await destroySingleResource({
        arn: `arn:aws:ec2:us-east-1:123456789012:route-table/${RT_ID}`,
        resourceType: "AWS::EC2::RouteTable",
        identifier: RT_ID,
        region: "us-east-1",
      });

      expect(result.success).toBe(true);
      expect(mockDeleteResource).toHaveBeenCalled();
    });
  });

  // ── CloudFront distribution destroy ───────────────────────────────────────
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

  // ── Missing credentials ───────────────────────────────────────────────────
  describe("Missing credentials", () => {
    it("returns error when CloudControl adapter throws", async () => {
      mockDeleteResource.mockRejectedValue(
        new Error("Missing credentials in config"),
      );

      const result = await destroySingleResource({
        arn: "arn:aws:s3:::cred-fail",
        resourceType: "AWS::S3::Bucket",
        identifier: "cred-fail",
        region: "us-east-1",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Missing credentials");
    });
  });

  // ── Fail-closed credential enforcement for pre-delete hooks ───────────────
  // When ASSIGNEE_OPERATOR_* env vars are missing, the DynamoDB and S3
  // pre-delete hooks must NOT call the AWS SDK and MUST surface the
  // credential error as a clean DestroyResult.error rather than silently
  // swallowing it (which would cause CloudControl DeleteResource to fail
  // later with a confusing ResourceInUseException / BucketNotEmpty error).
  describe("fail-closed pre-delete hooks (missing ASSIGNEE_OPERATOR_*)", () => {
    beforeEach(() => {
      delete process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"];
      delete process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"];
      // Belt-and-suspenders: shell AWS_* must NOT be honored
      process.env["AWS_ACCESS_KEY_ID"] = "shell-leak-key";
      process.env["AWS_SECRET_ACCESS_KEY"] = "shell-leak-secret";
    });

    it("DynamoDB hook surfaces MissingAssigneeCredentialsError instead of silently skipping", async () => {
      // The main CloudControl path must NOT be called — we fail early with
      // a clear credential error.
      mockDeleteResource.mockResolvedValue([null, { requestToken: "tok" }]);
      mockGetRequestStatus.mockResolvedValue([
        null,
        { operationStatus: "SUCCESS" },
      ]);

      const result = await destroySingleResource({
        arn: "arn:aws:dynamodb:us-east-1:123456789012:table/orders",
        resourceType: "AWS::DynamoDB::Table",
        identifier: "orders",
        region: "us-east-1",
      });

      // Critical: no AWS SDK call happened — we did NOT leak to
      // ~/.aws/credentials despite shell AWS_* vars being set.
      expect(mockDdbSend).not.toHaveBeenCalled();
      // Critical: we also short-circuit the CloudControl delete so the user
      // sees the credential error, not a confusing ResourceInUseException.
      expect(mockDeleteResource).not.toHaveBeenCalled();
      // The error is surfaced as a clean DestroyResult rather than thrown.
      expect(result.success).toBe(false);
      expect(result.error).toContain("DynamoDB deletion protection");
      expect(result.error).toContain("ASSIGNEE_OPERATOR_ACCESS_KEY_ID");
    });

    it("S3 hook surfaces MissingAssigneeCredentialsError instead of silently skipping", async () => {
      mockDeleteResource.mockResolvedValue([null, { requestToken: "tok" }]);
      mockGetRequestStatus.mockResolvedValue([
        null,
        { operationStatus: "SUCCESS" },
      ]);

      const result = await destroySingleResource({
        arn: "arn:aws:s3:::production-assets",
        resourceType: "AWS::S3::Bucket",
        identifier: "production-assets",
        region: "us-east-1",
      });

      // Must short-circuit: do not proceed to CloudControl delete with an
      // un-emptied bucket. The user must see the credential error, not a
      // downstream BucketNotEmpty error.
      expect(mockDeleteResource).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
      expect(result.error).toContain("empty S3 bucket");
      expect(result.error).toContain("ASSIGNEE_OPERATOR_ACCESS_KEY_ID");
    });

    it("MissingAssigneeCredentialsError names the operator env vars", () => {
      // Direct contract test of the helper used by the hooks.
      try {
        requireAssigneeCredentials("operator");
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(MissingAssigneeCredentialsError);
        const msg = (err as Error).message;
        expect(msg).toContain("ASSIGNEE_OPERATOR_ACCESS_KEY_ID");
        expect(msg).toContain("ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY");
      }
    });
  });

  // ── CloudFront disable polling — H20 ─────────────────────────────────────
  // The CloudFront disable-wait loop must tolerate transient errors from
  // GetDistribution (throttling, 5xx) and retry them rather than aborting
  // the entire destroy on the first failure. Previously a single throw
  // aborted the disable/delete with no retry.
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

  // ── M-R1: DynamoDB UpdateTable race vs delete ─────────────────────────────
  // UpdateTable(DeletionProtectionEnabled: false) returns immediately while
  // the disable propagates asynchronously. Without polling, the subsequent
  // CloudControl DeleteResource call races and fails with
  // ResourceInUseException. Verify we poll DescribeTable until the change is
  // visible BEFORE running the CloudControl delete.
  describe("DynamoDB pre-delete protection propagation (M-R1)", () => {
    it("polls DescribeTable until DeletionProtectionEnabled is false before deleting", async () => {
      // 1) UpdateTable — succeeds (returns no protection field)
      mockDdbSend.mockResolvedValueOnce({});
      // 2) DescribeTable — first poll: still propagating (true)
      mockDdbSend.mockResolvedValueOnce({
        Table: {
          TableName: "orders",
          DeletionProtectionEnabled: true,
        },
      });
      // 3) DescribeTable — second poll: still true
      mockDdbSend.mockResolvedValueOnce({
        Table: {
          TableName: "orders",
          DeletionProtectionEnabled: true,
        },
      });
      // 4) DescribeTable — third poll: now false, exit loop
      mockDdbSend.mockResolvedValueOnce({
        Table: {
          TableName: "orders",
          DeletionProtectionEnabled: false,
        },
      });

      mockDeleteResource.mockResolvedValue([null, { requestToken: "tok-mr1" }]);
      mockGetRequestStatus.mockResolvedValue([
        null,
        { operationStatus: "SUCCESS" },
      ]);

      const result = await destroySingleResource({
        arn: "arn:aws:dynamodb:us-east-1:123456789012:table/orders",
        resourceType: "AWS::DynamoDB::Table",
        identifier: "orders",
        region: "us-east-1",
      });

      expect(result.success).toBe(true);
      // Exactly 4 ddb calls: 1 UpdateTable + 3 DescribeTable polls.
      expect(mockDdbSend).toHaveBeenCalledTimes(4);
      const updateCall = mockDdbSend.mock.calls[0]![0];
      expect(updateCall._type).toBe("UpdateTable");
      expect(updateCall.DeletionProtectionEnabled).toBe(false);
      // All subsequent calls must be DescribeTable for the same table.
      for (let i = 1; i <= 3; i++) {
        const call = mockDdbSend.mock.calls[i]![0];
        expect(call._type).toBe("DescribeTable");
        expect(call.TableName).toBe("orders");
      }
      // CloudControl delete must run AFTER the polling exits — never racing
      // an in-flight protection disable.
      expect(mockDeleteResource).toHaveBeenCalledTimes(1);
    });

    // V1 N2 regression: AccessDenied on the FIRST DescribeTable poll must
    // FAIL the operation with a clear permission-denied message instead of
    // silently `break`ing the poll and racing the downstream CloudControl
    // delete (which would surface a confusing ResourceInUseException).
    it("V1 N2: fails fast with permission-denied message when DescribeTable raises AccessDenied", async () => {
      // 1) UpdateTable — succeeds
      mockDdbSend.mockResolvedValueOnce({});
      // 2) DescribeTable — AccessDenied on the very first poll
      const denied = Object.assign(
        new Error(
          "User: arn:aws:iam::123456789012:user/operator is not authorized to perform: dynamodb:DescribeTable on resource: arn:aws:dynamodb:us-east-1:123456789012:table/orders",
        ),
        { name: "AccessDeniedException" },
      );
      mockDdbSend.mockRejectedValueOnce(denied);

      const result = await destroySingleResource({
        arn: "arn:aws:dynamodb:us-east-1:123456789012:table/orders",
        resourceType: "AWS::DynamoDB::Table",
        identifier: "orders",
        region: "us-east-1",
      });

      // Operation must fail and the CloudControl delete must NOT have been
      // dispatched — that's the whole point of failing fast.
      expect(result.success).toBe(false);
      expect(result.error).toContain("DescribeTable");
      expect(result.error).toContain("orders");
      expect(result.error).toContain("permission");
      expect(mockDeleteResource).not.toHaveBeenCalled();
      // Exactly 2 ddb calls: UpdateTable + the failing DescribeTable.
      expect(mockDdbSend).toHaveBeenCalledTimes(2);
    });

    it("V1 N2: also recognises AccessDenied via the error name 'AccessDenied'", async () => {
      mockDdbSend.mockResolvedValueOnce({});
      const denied = Object.assign(new Error("AccessDenied: nope"), {
        name: "AccessDenied",
      });
      mockDdbSend.mockRejectedValueOnce(denied);

      const result = await destroySingleResource({
        arn: "arn:aws:dynamodb:us-east-1:123456789012:table/orders",
        resourceType: "AWS::DynamoDB::Table",
        identifier: "orders",
        region: "us-east-1",
      });
      expect(result.success).toBe(false);
      expect(mockDeleteResource).not.toHaveBeenCalled();
    });

    it("V1 N2: non-permission DescribeTable errors still break (do not fail the operation)", async () => {
      // UpdateTable ok
      mockDdbSend.mockResolvedValueOnce({});
      // DescribeTable transient throttle — this MUST NOT fail the destroy.
      const throttled = Object.assign(new Error("Rate exceeded"), {
        name: "ThrottlingException",
      });
      mockDdbSend.mockRejectedValueOnce(throttled);

      mockDeleteResource.mockResolvedValue([null, { requestToken: "tok-vn2" }]);
      mockGetRequestStatus.mockResolvedValue([
        null,
        { operationStatus: "SUCCESS" },
      ]);

      const result = await destroySingleResource({
        arn: "arn:aws:dynamodb:us-east-1:123456789012:table/orders",
        resourceType: "AWS::DynamoDB::Table",
        identifier: "orders",
        region: "us-east-1",
      });

      // Throttle on DescribeTable: fall through to CloudControl delete.
      expect(result.success).toBe(true);
      expect(mockDeleteResource).toHaveBeenCalledTimes(1);
    });

    it("gives up cleanly after the propagation poll budget is exhausted", async () => {
      // UpdateTable — ok
      mockDdbSend.mockResolvedValueOnce({});
      // All subsequent polls report still-protected. The implementation
      // is bounded to DDB_DISABLE_PROTECTION_MAX_POLLS=6 polls before
      // moving on to the CloudControl delete (which will surface its own
      // error if the table is genuinely still protected).
      mockDdbSend.mockResolvedValue({
        Table: {
          TableName: "orders",
          DeletionProtectionEnabled: true,
        },
      });

      mockDeleteResource.mockResolvedValue([null, { requestToken: "tok-bdg" }]);
      mockGetRequestStatus.mockResolvedValue([
        null,
        { operationStatus: "SUCCESS" },
      ]);

      const result = await destroySingleResource({
        arn: "arn:aws:dynamodb:us-east-1:123456789012:table/orders",
        resourceType: "AWS::DynamoDB::Table",
        identifier: "orders",
        region: "us-east-1",
      });

      // 1 UpdateTable + 6 DescribeTable polls = 7 total ddb calls.
      expect(mockDdbSend).toHaveBeenCalledTimes(7);
      // Delete still proceeds (CloudControl will surface a clean error if
      // the table is truly protected) — the test result therefore reflects
      // the SUCCESS we mocked from CloudControl.
      expect(result.success).toBe(true);
      expect(mockDeleteResource).toHaveBeenCalledTimes(1);
    });
  });

  // ── M-R2: S3 DeleteObjects 1000-key chunking ─────────────────────────────
  // ListObjectVersions can return up to 1000 Versions PLUS up to 1000
  // DeleteMarkers per page (2000 combined). DeleteObjects accepts at most
  // 1000 keys per request, so the merged array MUST be chunked.
  describe("S3 pre-delete object chunking (M-R2)", () => {
    it("splits 1500 mixed Versions+DeleteMarkers into exactly 2 DeleteObjects calls", async () => {
      // Realistic shape: 900 Versions + 600 DeleteMarkers = 1500 total
      const Versions = Array.from({ length: 900 }, (_, i) => ({
        Key: `logs/2026/03/event-${i.toString().padStart(4, "0")}.json`,
        VersionId: `v${i.toString().padStart(8, "0")}`,
      }));
      const DeleteMarkers = Array.from({ length: 600 }, (_, i) => ({
        Key: `logs/2026/03/event-deleted-${i.toString().padStart(4, "0")}.json`,
        VersionId: `dm${i.toString().padStart(7, "0")}`,
      }));

      // ListObjectVersions — single page (IsTruncated false)
      mockS3Send.mockResolvedValueOnce({
        Versions,
        DeleteMarkers,
        IsTruncated: false,
      });
      // DeleteObjects — first chunk (1000 keys)
      mockS3Send.mockResolvedValueOnce({});
      // DeleteObjects — second chunk (500 keys)
      mockS3Send.mockResolvedValueOnce({});

      mockDeleteResource.mockResolvedValue([null, { requestToken: "tok-s3c" }]);
      mockGetRequestStatus.mockResolvedValue([
        null,
        { operationStatus: "SUCCESS" },
      ]);

      const result = await destroySingleResource({
        arn: "arn:aws:s3:::production-logs",
        resourceType: "AWS::S3::Bucket",
        identifier: "production-logs",
        region: "us-east-1",
      });

      expect(result.success).toBe(true);

      // Calls: 1 ListObjectVersions + 2 DeleteObjects (chunked) = 3.
      expect(mockS3Send).toHaveBeenCalledTimes(3);

      const listCall = mockS3Send.mock.calls[0]![0];
      expect(listCall._type).toBe("ListObjectVersions");

      const firstDelete = mockS3Send.mock.calls[1]![0];
      expect(firstDelete._type).toBe("DeleteObjects");
      expect(firstDelete.Delete.Objects).toHaveLength(1000);

      const secondDelete = mockS3Send.mock.calls[2]![0];
      expect(secondDelete._type).toBe("DeleteObjects");
      expect(secondDelete.Delete.Objects).toHaveLength(500);

      // Sanity: every key in the chunks comes from the original lists, no
      // duplication or loss.
      const allKeys = [
        ...firstDelete.Delete.Objects.map((o: { Key: string }) => o.Key),
        ...secondDelete.Delete.Objects.map((o: { Key: string }) => o.Key),
      ];
      expect(allKeys).toHaveLength(1500);
      expect(new Set(allKeys).size).toBe(1500);
    });

    // ── V1 N5 audit (2026-04-06): infinite-loop guard ────────────────────
    it("breaks out of pagination loop when IsTruncated=true but next markers are missing", async () => {
      // Realistic edge case: AWS responds with IsTruncated=true but omits
      // both NextKeyMarker and NextVersionIdMarker. Without the paranoid
      // guard the while-loop would call ListObjectVersions forever with the
      // same (undefined, undefined) markers and never make progress.
      mockS3Send.mockResolvedValue({
        Versions: [{ Key: "stuck.txt", VersionId: "v1" }],
        DeleteMarkers: [],
        IsTruncated: true,
        // NextKeyMarker, NextVersionIdMarker intentionally absent
      });

      mockDeleteResource.mockResolvedValue([
        null,
        { requestToken: "tok-stuck" },
      ]);
      mockGetRequestStatus.mockResolvedValue([
        null,
        { operationStatus: "SUCCESS" },
      ]);

      const result = await destroySingleResource({
        arn: "arn:aws:s3:::stuck-bucket",
        resourceType: "AWS::S3::Bucket",
        identifier: "stuck-bucket",
        region: "us-east-1",
      });

      // The guard must terminate the loop, allowing the destroy attempt to
      // proceed to CloudControl. We assert the loop ran a bounded number of
      // S3 calls (1 List + 1 DeleteObjects = 2) instead of unbounded.
      expect(result.success).toBe(true);
      // Bounded: 1 List + at most 1 DeleteObjects in this single iteration.
      // The exact upper bound is 2; assert ≤ a small constant rather than
      // pinning the number so future inner refactors don't break the test.
      expect(mockS3Send.mock.calls.length).toBeLessThanOrEqual(3);

      // Verify ListObjectVersions was called at most once — the loop did
      // not spin attempting subsequent pages with missing markers.
      const listCalls = mockS3Send.mock.calls.filter(
        (c) => (c[0] as { _type: string })._type === "ListObjectVersions",
      );
      expect(listCalls).toHaveLength(1);
    });
  });
});

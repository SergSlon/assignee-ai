/**
 * Tests for destroy-service.ts — single-resource happy paths and NotFound.
 *
 * Split from destroy-service.test.ts (Wave 3 F9 P2-6). Covers: CCAPI happy
 * path, NotFound short-circuit (both error-on-delete and FAILED+NotFound on
 * poll), cross-account NotFound blocking, Lambda EventSourceMapping (A6),
 * SNS Subscription (A10), SNS Topic (A6), redirect types, missing creds.
 *
 * @see Story 36.1
 */
import { describe, it, expect } from "vitest";
// Wave-4 F5 P2-R2-16: the ~210-LOC mock harness shared with
// destroy-service-{alb,cloudfront,predelete}.test.ts now lives in
// ./destroy-service-mocks.ts. Importing it installs every vi.mock() and
// exposes the hoisted mock handles + setupDestroyServiceMocks() helper.
// Wave-4 F5 P2-R2-8: dropped dead `MissingAssigneeCredentialsError` +
// `requireAssigneeCredentials` imports — this suite never uses them.
import {
  mockDeleteResource,
  mockGetRequestStatus,
  mockGetOperatorAccountId,
  setupDestroyServiceMocks,
} from "./destroy-service-mocks.js";

// ── Import after mocks ────────────────────────────────────────────────────────
import { destroySingleResource } from "../destroy-service.js";

setupDestroyServiceMocks();

describe("destroySingleResource", () => {
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
      // all DESTROY_MAX_POLL_ATTEMPTS iterations complete instantly.
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
      // Verify all poll attempts were made (was 60; bumped to 600 for RDS/CloudFront)
      expect(mockGetRequestStatus).toHaveBeenCalledTimes(600);
    }, 30_000);

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
      mockGetOperatorAccountId.mockResolvedValue("210987654321");
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
      // Operator is configured for 210987654321...
      mockGetOperatorAccountId.mockResolvedValue("210987654321");
      mockDeleteResource.mockResolvedValue([
        {
          kind: "NOT_FOUND",
          message: "Resource not found.",
        },
        null,
      ]);

      const result = await destroySingleResource({
        // ...but the ARN encodes account 109876543210 — the resource
        // legitimately exists in a different account that the operator
        // can't see.
        arn: "arn:aws:ec2:us-east-1:109876543210:natgateway/nat-0b337150b5f9b0b62",
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
      mockGetOperatorAccountId.mockResolvedValue("210987654321");
      mockDeleteResource.mockResolvedValue([
        {
          kind: "NOT_FOUND",
          message: "Resource not found.",
        },
        null,
      ]);

      const result = await destroySingleResource({
        arn: "arn:aws:ec2:us-east-1:210987654321:natgateway/nat-0928a4abb02ca9eb3",
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
      mockGetOperatorAccountId.mockResolvedValue("210987654321");
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
        arn: "arn:aws:ec2:us-east-1:109876543210:natgateway/nat-0xxx",
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
      // 2026-04-14: SNS Topic is now in ARN_IDENTIFIED_TYPES — destroy-service
      // passes resource.arn (full ARN) to CCAPI, not the extracted identifier.
      // This matches CCAPI's schema (primary identifier is TopicArn).
      expect(mockDeleteResource).toHaveBeenCalledWith(
        "AWS::SNS::Topic",
        "arn:aws:sns:us-east-1:123456:my-topic",
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
});

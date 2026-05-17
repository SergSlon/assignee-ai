/**
 * Tests for destroy-service.ts — pre-delete hooks.
 *
 * Split from destroy-service.test.ts (Wave 3 F9 P2-6). Covers every resource
 * type whose destroy flow requires an SDK pre-delete step before CCAPI:
 * DynamoDB (disable DeletionProtection), InternetGateway (detach from VPC),
 * RouteTable (disassociate subnets), plus fail-closed coverage for missing
 * ASSIGNEE_OPERATOR_* credentials, DynamoDB protection propagation (M-R1),
 * and S3 object chunking (M-R2).
 *
 * @see Story 36.1
 */
import { describe, it, expect, beforeEach } from "vitest";
import { MissingAssigneeCredentialsError } from "@assignee/core";
import { requireAssigneeCredentials } from "../../config/aws-credentials.js";
// Wave-4 F5 P2-R2-16: shared mock harness (see destroy-service-mocks.ts).
import {
  mockDeleteResource,
  mockGetRequestStatus,
  mockDdbSend,
  mockS3Send,
  mockEc2Send,
  setupDestroyServiceMocks,
} from "./destroy-service-mocks.js";

// ── Import after mocks ────────────────────────────────────────────────────────
import { destroySingleResource } from "../destroy-service.js";

setupDestroyServiceMocks();

describe("destroySingleResource", () => {
  describe("DynamoDB pre-delete hook", () => {
    it("disables deletion protection before deleting", async () => {
      // UpdateTable + DescribeTable polls both resolve to this shape. An
      // empty-body success (no `Table` field) means the DescribeTable poll
      // reads `described.Table?.DeletionProtectionEnabled` as undefined →
      // !== true → propagation-poll exits immediately (intended behavior
      // for this happy-path test that is NOT exercising propagation).
      mockDdbSend.mockResolvedValue({
        $metadata: { httpStatusCode: 200, requestId: "test-req-ddb" },
      });
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

  // Wave 4 F2 (P1-R2-2): destroy-service previously used a 3-way substring
  // match on err.message (includes "AccessDenied" || "not authorized" ||
  // "UnauthorizedOperation"). This test proves the structured classifier
  // has replaced it: an AccessDenied error whose MESSAGE does not contain
  // any of those keywords (only the structured err.name does) must still
  // trigger the hard-fail IAM-remediation path.
  describe("Wave 4 F2: S3 empty-bucket AccessDenied uses structured classifier", () => {
    it("fails with IAM remediation message when ListObjectVersions throws an error with structured name only", async () => {
      // Realistic shape: SDK v3 wraps AccessDenied in an error whose
      // message is the localized server text (no English keywords) but
      // whose name field carries the canonical code.
      const denied = Object.assign(
        new Error("Operación no autorizada"), // intentionally non-English
        {
          name: "AccessDeniedException",
          $metadata: { httpStatusCode: 403 },
        },
      );
      mockS3Send.mockRejectedValueOnce(denied);

      const result = await destroySingleResource({
        arn: "arn:aws:s3:::prod-i18n-bucket",
        resourceType: "AWS::S3::Bucket",
        identifier: "prod-i18n-bucket",
        region: "us-east-1",
      });

      // Pre-fix regression: the substring match would have missed this
      // and fallen into the "continue with DeleteBucket" branch, causing
      // a downstream BucketNotEmpty on non-empty buckets.
      expect(result.success).toBe(false);
      expect(result.error).toContain("empty S3 bucket");
      // Story 108-A-05: path is now noun-grouped `assignee dev setup`.
      expect(result.error).toContain("assignee dev setup");
      // CloudControl delete MUST NOT have been attempted
      expect(mockDeleteResource).not.toHaveBeenCalled();
    });

    it("matches on HTTP 403 even when err.name is generic", async () => {
      const denied = Object.assign(new Error("forbidden"), {
        name: "S3ServiceException",
        $metadata: { httpStatusCode: 403 },
      });
      mockS3Send.mockRejectedValueOnce(denied);

      const result = await destroySingleResource({
        arn: "arn:aws:s3:::prod-403-bucket",
        resourceType: "AWS::S3::Bucket",
        identifier: "prod-403-bucket",
        region: "us-east-1",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("empty S3 bucket");
    });
  });
});

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
import { describe, it, expect, vi } from "vitest";
// Wave-4 F5 P2-R2-16: shared mock harness (see destroy-service-mocks.ts).
import {
  mockDeleteResource,
  mockGetRequestStatus,
  mockEc2Send,
  setupDestroyServiceMocks,
} from "./destroy-service-mocks.js";

// ── Import after mocks ────────────────────────────────────────────────────────
import { destroySingleResource } from "../destroy-service.js";

setupDestroyServiceMocks();

describe("destroySingleResource", () => {
  describe("ALB post-delete ENI drain", () => {
    const ALB_ARN =
      "arn:aws:elasticloadbalancing:us-east-1:112233445566:loadbalancer/app/assignee-alb-test/abc123def456";

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
      // Wave-4 F5 P2-R2-7: previously this test asserted only
      // `result.success === true`, which a silent no-op would pass — the
      // ENI-drain block could be deleted entirely and the test would still
      // go green. Tighten to three invariants:
      //   1. The drain was attempted (ALB type-match branch was entered).
      //   2. The missing-creds error was caught & surfaced via warnDestroy
      //      (stderr write with action "alb_eni_drain_failed").
      //   3. Because the EC2Client constructor never received valid creds,
      //      DescribeNetworkInterfaces was NEVER actually called.
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

      // Spy stderr so we can assert warnDestroy fired with the expected
      // structured-log action. warnDestroy writes to process.stderr directly
      // (no runId plumbing available in destroy-service).
      const stderrSpy = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);

      const result = await destroySingleResource({
        arn: ALB_ARN,
        resourceType: "AWS::ElasticLoadBalancingV2::LoadBalancer",
        identifier: ALB_ARN,
        region: "us-east-1",
      });

      // (1) Delete still succeeds — ENI drain is non-fatal
      expect(result.success).toBe(true);

      // (2) warnDestroy fired the structured alb_eni_drain_failed line
      // (proves the ALB branch WAS entered and the missing-creds error
      // was caught by the non-fatal try/catch, not silently skipped).
      const drainWarns = stderrSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((line) => line.includes('"action":"alb_eni_drain_failed"'));
      expect(drainWarns.length).toBeGreaterThanOrEqual(1);
      // The warn line must also include the identifier so operators can
      // correlate this to the failed destroy; a silent no-op would have
      // no such line at all.
      expect(drainWarns[0]).toContain(ALB_ARN);

      // (3) EC2 client construction failed before any SDK call fired, so
      // DescribeNetworkInterfaces must NOT have been invoked. This
      // distinguishes "creds missing, cleanly non-fatal" from a silent
      // no-op where the hook was removed entirely (which would also leave
      // mockEc2Send uncalled but would have no warn either).
      const eniCalls = mockEc2Send.mock.calls.filter(
        (c) =>
          (c[0] as { _type: string })._type === "DescribeNetworkInterfaces",
      );
      expect(eniCalls).toHaveLength(0);

      stderrSpy.mockRestore();
    });
  });
});

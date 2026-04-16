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
import { describe, it, expect } from "vitest";
// Wave-4 F5 P2-R2-16: shared mock harness (see destroy-service-mocks.ts).
// Wave-4 F5 P2-R2-8: dropped dead `MissingAssigneeCredentialsError` import
// — this suite never constructs / catches it directly.
import {
  mockCfSend,
  setupDestroyServiceMocks,
} from "./destroy-service-mocks.js";

// ── Import after mocks ────────────────────────────────────────────────────────
import { destroySingleResource } from "../destroy-service.js";

setupDestroyServiceMocks();

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

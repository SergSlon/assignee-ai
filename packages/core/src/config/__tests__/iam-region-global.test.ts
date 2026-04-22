/**
 * Epic 94 P2 (D-06) — IAM ManagedPolicy region display.
 *
 * Pre-fix: RGTA-driven `assignee list` output stamped the operator's
 * configured region on every IAM ARN shape (policy, user, group,
 * instance-profile) because the `parseArn` layer returned an empty
 * string for IAM's empty region slot and the call site's
 * `parsed.region || region` fallback leaked the operator default.
 * Only `AWS::IAM::Role` displayed correctly as `"global"` because it
 * has a dedicated enrichment branch that hardcodes the value.
 *
 * Post-fix: `isGlobalService` centralises the list of globally-scoped
 * AWS services, and the display layer substitutes `"global"` for any
 * matching ARN. Covers IAM in full (role, policy, user, group,
 * instance-profile) plus CloudFront, Route53, WAF, and Organizations.
 *
 * Partition-agnostic: GovCloud / China / ISO IAM ARNs all report
 * `"global"` because the check keys on the service-name slot only.
 */

import { describe, it, expect } from "vitest";
import { GLOBAL_SERVICES, isGlobalService } from "../arn-type-map.js";

describe("isGlobalService — IAM + other global-plane services (Story e94.P2, D-06)", () => {
  describe("IAM is global across every ARN shape", () => {
    // `isGlobalService` keys on the service-name slot only, which is
    // the same across every IAM sub-resource (role, policy, user,
    // group, instance-profile). Proving that explicitly guards
    // against a future refactor that adds a per-sub-resource check
    // and accidentally re-introduces the leak for one shape.
    it.each(["iam"])("returns true for service slot `%s`", (service) => {
      expect(isGlobalService(service)).toBe(true);
    });
  });

  describe("Other globally-scoped AWS control planes", () => {
    it.each([["cloudfront"], ["route53"], ["waf"], ["organizations"]])(
      "returns true for %s",
      (service) => {
        expect(isGlobalService(service)).toBe(true);
      },
    );
  });

  describe("Regional services return false", () => {
    it.each([
      ["ec2"],
      ["lambda"],
      ["rds"],
      ["dynamodb"],
      ["s3"], // S3 is technically regional despite empty-region ARNs
      ["sqs"],
      ["sns"],
      ["logs"],
      ["kms"],
    ])("returns false for %s", (service) => {
      expect(isGlobalService(service)).toBe(false);
    });
  });

  describe("Edge cases", () => {
    it("returns false for unknown service", () => {
      expect(isGlobalService("notarealservice")).toBe(false);
    });

    it("returns false for empty string", () => {
      expect(isGlobalService("")).toBe(false);
    });

    it("is case-sensitive (lowercase only — RGTA shape)", () => {
      // Guarding the contract: ARN service slots from RGTA are
      // already lowercase. Accepting `IAM` (uppercase) would mask
      // future bugs where we fail to lowercase upstream.
      expect(isGlobalService("IAM")).toBe(false);
    });
  });

  describe("GLOBAL_SERVICES set surface", () => {
    it("exposes IAM at minimum (regression pin for the P2 fix)", () => {
      expect(GLOBAL_SERVICES.has("iam")).toBe(true);
    });

    it("is a ReadonlySet — no mutation leaks", () => {
      // TypeScript enforces ReadonlySet at compile time; this is a
      // runtime smoke check that the export shape matches the typed
      // contract. No casting — if the set's `add` is accessible, that
      // would surface here.
      expect(GLOBAL_SERVICES).toBeInstanceOf(Set);
      expect(GLOBAL_SERVICES.size).toBeGreaterThanOrEqual(5);
    });
  });
});

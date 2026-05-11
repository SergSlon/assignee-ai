import { describe, it, expect } from "vitest";

import { PROVISIONING_ERROR_CODES } from "@/errors.js";
import { ProvisioningErrorKind } from "@/ports/provisioning-port.js";
import { classifyCreateError } from "./error-classifier.js";

/**
 * Story 53-it1-12 — lifts the legacy three-way nested-ternary chain
 * (userPrefix × errorCode × shortMessage) out of resource-provisioner.ts
 * into a single dispatch-table lookup. These tests lock in the exact
 * observable behaviour that resource-provisioner.test.ts depends on
 * (S3 bucket special-casing, THROTTLED mapping, UNKNOWN fall-through)
 * AND the dispatch-table contract for the kinds that were previously
 * lumped into the "default" branch (NOT_FOUND / ACCESS_DENIED /
 * SERVICE_ERROR) so regressions get caught in a focused unit test
 * instead of only at the orchestrator integration layer.
 */
describe("classifyCreateError", () => {
  describe("ALREADY_EXISTS", () => {
    it("returns the S3-specific global-namespace prefix for S3 buckets", () => {
      const result = classifyCreateError(
        {
          kind: ProvisioningErrorKind.ALREADY_EXISTS,
          message: "Bucket already exists in another account.",
        },
        "AWS::S3::Bucket",
      );

      expect(result.errorCode).toBe(PROVISIONING_ERROR_CODES.ALREADY_EXISTS);
      expect(result.userPrefix).toBe(
        "S3 bucket name is already taken globally. Choose a different name.",
      );
      expect(result.shortMessage).toBe("Resource already exists");
    });

    it("returns the generic 'Resource already exists' prefix for non-S3 types", () => {
      const result = classifyCreateError(
        {
          kind: ProvisioningErrorKind.ALREADY_EXISTS,
          message: "IAM role with name MyRole already exists.",
        },
        "AWS::IAM::Role",
      );

      expect(result.errorCode).toBe(PROVISIONING_ERROR_CODES.ALREADY_EXISTS);
      expect(result.userPrefix).toBe(
        "Resource already exists. Choose a different name.",
      );
      expect(result.shortMessage).toBe("Resource already exists");
    });

    it("treats undefined resourceType as non-S3 (generic prefix)", () => {
      const result = classifyCreateError(
        {
          kind: ProvisioningErrorKind.ALREADY_EXISTS,
          message: "collision",
        },
        undefined,
      );

      expect(result.userPrefix).toBe(
        "Resource already exists. Choose a different name.",
      );
    });
  });

  describe("THROTTLED", () => {
    it("maps THROTTLED to the throttled prefix + THROTTLED code", () => {
      const result = classifyCreateError(
        {
          kind: ProvisioningErrorKind.THROTTLED,
          message: "Rate exceeded",
        },
        "AWS::EC2::Instance",
      );

      expect(result.errorCode).toBe(PROVISIONING_ERROR_CODES.THROTTLED);
      expect(result.userPrefix).toBe(
        "Request throttled by AWS. Please wait and retry.",
      );
      expect(result.shortMessage).toBe("Request throttled by AWS");
    });

    it("THROTTLED prefix ignores the raw adapter message", () => {
      // The raw message may contain a stack trace or internal AWS detail
      // we do not want to leak to the user-facing errorMessage. The
      // dispatch table maps to a stable sentence.
      const result = classifyCreateError(
        {
          kind: ProvisioningErrorKind.THROTTLED,
          message:
            "Rate exceeded for operation CreateResource on account 123456789012",
        },
        "AWS::RDS::DBInstance",
      );

      expect(result.userPrefix).toBe(
        "Request throttled by AWS. Please wait and retry.",
      );
    });
  });

  describe("UNKNOWN fall-through kinds", () => {
    it("maps UNKNOWN to the raw adapter message + UNKNOWN code", () => {
      const result = classifyCreateError(
        {
          kind: ProvisioningErrorKind.UNKNOWN,
          message: "Unable to locate credentials.",
        },
        "AWS::IAM::Role",
      );

      expect(result.errorCode).toBe(PROVISIONING_ERROR_CODES.UNKNOWN);
      expect(result.userPrefix).toBe("Unable to locate credentials.");
      expect(result.shortMessage).toBe("Unable to locate credentials.");
    });

    it("maps ACCESS_DENIED to UNKNOWN code with raw message (no friendly prefix)", () => {
      // ACCESS_DENIED is treated as UNKNOWN by the current dispatch
      // contract — the adapter's raw message (e.g. full IAM deny
      // diagnostic) is the most useful thing to surface to the user.
      const result = classifyCreateError(
        {
          kind: ProvisioningErrorKind.ACCESS_DENIED,
          message:
            "User: arn:aws:iam::123456789012:user/dev is not authorized to perform: ec2:RunInstances",
        },
        "AWS::EC2::Instance",
      );

      expect(result.errorCode).toBe(PROVISIONING_ERROR_CODES.UNKNOWN);
      expect(result.userPrefix).toContain("not authorized to perform");
      expect(result.shortMessage).toContain("not authorized to perform");
    });

    it("maps NOT_FOUND (on create, e.g. VPC dependency) to raw message + UNKNOWN code", () => {
      const result = classifyCreateError(
        {
          kind: ProvisioningErrorKind.NOT_FOUND,
          message: "VpcId vpc-000 does not exist.",
        },
        "AWS::EC2::Subnet",
      );

      expect(result.errorCode).toBe(PROVISIONING_ERROR_CODES.UNKNOWN);
      expect(result.userPrefix).toBe("VpcId vpc-000 does not exist.");
      expect(result.shortMessage).toBe("VpcId vpc-000 does not exist.");
    });

    it("maps SERVICE_ERROR to raw message + UNKNOWN code", () => {
      const result = classifyCreateError(
        {
          kind: ProvisioningErrorKind.SERVICE_ERROR,
          message: "Internal service error, please retry.",
        },
        "AWS::Lambda::Function",
      );

      expect(result.errorCode).toBe(PROVISIONING_ERROR_CODES.UNKNOWN);
      expect(result.userPrefix).toBe("Internal service error, please retry.");
      expect(result.shortMessage).toBe("Internal service error, please retry.");
    });

    it("maps DDB AttributeDefinitions/KeySchema mismatch to UNKNOWN code with actionable hint", () => {
      // Real CCAPI error text reproduced verbatim — the classifier must
      // recognise the substring (case-insensitive) and return the actionable
      // hint that tells the user about TTL attrs vs key attrs.
      const rawMsg =
        "Number of attributes in KeySchema does not exactly match number of attributes defined in AttributeDefinitions";

      const result = classifyCreateError(
        {
          kind: ProvisioningErrorKind.SERVICE_ERROR,
          message: rawMsg,
        },
        "AWS::DynamoDB::Table",
      );

      expect(result.errorCode).toBe(PROVISIONING_ERROR_CODES.UNKNOWN);
      // userPrefix must contain the actionable guidance — not the raw AWS msg
      expect(result.userPrefix).toContain("AttributeDefinitions");
      expect(result.userPrefix).toContain("TTL");
      expect(result.userPrefix).toContain("sanitizer");
      // shortMessage is the same hint
      expect(result.shortMessage).toContain("AttributeDefinitions");
      // The raw AWS error text must NOT be the prefix (it's been replaced)
      expect(result.userPrefix).not.toBe(rawMsg);
      // Raw AWS message MUST be preserved in both surfaces so operators can
      // grep logs / paste into AWS support tickets without losing the
      // canonical CCAPI string (reviewer-flagged H1 on commit d6f456de).
      expect(result.userPrefix).toContain(rawMsg);
      expect(result.shortMessage).toContain(rawMsg);
    });

    it("preserves the unmodified raw message for non-DDB SERVICE_ERROR", () => {
      // The DDB hint must NOT fire on unrelated SERVICE_ERROR messages —
      // those must keep the original raw text as both userPrefix and
      // shortMessage so debugging is unaffected.
      const rawMsg =
        "Unable to validate the following destination configurations (Service: AWSLambda)";

      const result = classifyCreateError(
        {
          kind: ProvisioningErrorKind.SERVICE_ERROR,
          message: rawMsg,
        },
        "AWS::Lambda::Function",
      );

      expect(result.errorCode).toBe(PROVISIONING_ERROR_CODES.UNKNOWN);
      expect(result.userPrefix).toBe(rawMsg);
      expect(result.shortMessage).toBe(rawMsg);
      expect(result.userPrefix).not.toContain("AttributeDefinitions");
    });
  });
});

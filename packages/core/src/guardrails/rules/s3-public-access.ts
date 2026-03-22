/**
 * Guardrail rule: S3 public access detection.
 * Checks that all PublicAccessBlockConfiguration fields are explicitly true.
 * Any field that is false or missing triggers a critical finding.
 *
 * @see Story 10.4, Task 2.1
 */

import type { GuardrailRule } from "../types.js";

const PUBLIC_ACCESS_FIELDS = [
  "BlockPublicAcls",
  "BlockPublicPolicy",
  "IgnorePublicAcls",
  "RestrictPublicBuckets",
] as const;

/** Detects S3 buckets with public access enabled (any BlockPublic* field is false or missing). */
export const s3PublicAccessRule: GuardrailRule = {
  ruleId: "s3-public-access",
  resourceTypes: ["AWS::S3::Bucket"],
  evaluate: (_resourceType: string, desiredState: Record<string, unknown>) => {
    const config = desiredState["PublicAccessBlockConfiguration"] as
      | Record<string, unknown>
      | undefined;

    if (!config) {
      return {
        ruleId: "s3-public-access",
        severity: "critical",
        message:
          "S3 bucket is missing PublicAccessBlockConfiguration — public access may be allowed",
        field: "PublicAccessBlockConfiguration",
      };
    }

    const openFields = PUBLIC_ACCESS_FIELDS.filter(
      (field) => config[field] !== true,
    );

    if (openFields.length > 0) {
      return {
        ruleId: "s3-public-access",
        severity: "critical",
        message: `S3 bucket has public access enabled (${openFields.join(", ")} not blocked)`,
        field: "PublicAccessBlockConfiguration",
      };
    }

    return null;
  },
};

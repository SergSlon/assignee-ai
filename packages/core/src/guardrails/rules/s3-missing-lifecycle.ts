/**
 * Guardrail rule: S3 missing lifecycle configuration.
 * Checks that LifecycleConfiguration is defined and non-empty.
 *
 * @see Story 10.4, Task 2.2
 */

import type { GuardrailRule } from "../types.js";

/** Detects S3 buckets without lifecycle rules configured. */
export const s3MissingLifecycleRule: GuardrailRule = {
  ruleId: "s3-missing-lifecycle",
  resourceTypes: ["AWS::S3::Bucket"],
  evaluate: (_resourceType: string, desiredState: Record<string, unknown>) => {
    const lifecycle = desiredState["LifecycleConfiguration"];

    // Missing, false, null, undefined, or empty object/array
    if (
      !lifecycle ||
      lifecycle === false ||
      (typeof lifecycle === "object" &&
        Object.keys(lifecycle as Record<string, unknown>).length === 0)
    ) {
      return {
        ruleId: "s3-missing-lifecycle",
        severity: "warning",
        message:
          "S3 bucket is missing lifecycle rules — objects will never expire or transition",
        field: "LifecycleConfiguration",
      };
    }

    return null;
  },
};

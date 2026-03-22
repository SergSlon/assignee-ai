/**
 * Guardrail rule: Missing encryption at rest.
 * Checks S3 BucketEncryption and RDS StorageEncrypted fields.
 *
 * @see Story 10.4, Task 2.3
 */

import type { GuardrailRule } from "../types.js";

/** Detects storage/database resources missing encryption at rest. */
export const missingEncryptionRule: GuardrailRule = {
  ruleId: "missing-encryption",
  resourceTypes: ["AWS::S3::Bucket", "AWS::RDS::DBInstance"],
  evaluate: (resourceType: string, desiredState: Record<string, unknown>) => {
    if (resourceType === "AWS::S3::Bucket") {
      const encryption = desiredState["BucketEncryption"];
      if (!encryption || encryption === false) {
        return {
          ruleId: "missing-encryption",
          severity: "critical",
          message: "S3 bucket is missing encryption at rest (BucketEncryption)",
          field: "BucketEncryption",
        };
      }
    }

    if (resourceType === "AWS::RDS::DBInstance") {
      const encrypted = desiredState["StorageEncrypted"];
      if (!encrypted || encrypted === false) {
        return {
          ruleId: "missing-encryption",
          severity: "critical",
          message:
            "RDS instance is missing encryption at rest (StorageEncrypted)",
          field: "StorageEncrypted",
        };
      }
    }

    return null;
  },
};

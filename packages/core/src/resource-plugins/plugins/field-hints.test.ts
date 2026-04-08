import { describe, it, expect } from "vitest";
import { ec2InstancePlugin } from "./ec2-instance.js";
import { lambdaFunctionPlugin } from "./lambda-function.js";
import { rdsDbInstancePlugin } from "./rds-dbinstance.js";
import { s3BucketPlugin } from "./s3-bucket.js";
import { genericPlugin } from "./generic.js";
import type { ResourcePlugin } from "../types.js";

const MIN_HINT_LENGTH = 20;

function assertAllFieldsHaveHints(plugin: ResourcePlugin, pluginName: string) {
  const allFields = [...plugin.commonFields, ...(plugin.advancedFields ?? [])];

  for (const field of allFields) {
    it(`${pluginName} → ${field.name} has a non-empty hint (≥${MIN_HINT_LENGTH} chars)`, () => {
      // Tier C: dropped redundant toBeDefined() — typeof string check
      // already requires the value to be defined AND a string.
      expect(typeof field.question.hint).toBe("string");
      expect(field.question.hint!.length).toBeGreaterThanOrEqual(
        MIN_HINT_LENGTH,
      );
    });
  }
}

describe("All resource plugin fields have contextual hints", () => {
  describe("EC2 Instance plugin", () => {
    assertAllFieldsHaveHints(ec2InstancePlugin, "ec2-instance");
  });

  describe("Lambda Function plugin", () => {
    assertAllFieldsHaveHints(lambdaFunctionPlugin, "lambda-function");
  });

  describe("RDS DB Instance plugin", () => {
    assertAllFieldsHaveHints(rdsDbInstancePlugin, "rds-dbinstance");
  });

  describe("S3 Bucket plugin", () => {
    assertAllFieldsHaveHints(s3BucketPlugin, "s3-bucket");
  });

  describe("Generic plugin", () => {
    assertAllFieldsHaveHints(genericPlugin, "generic");
  });
});

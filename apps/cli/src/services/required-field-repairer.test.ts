/**
 * Tests for the generic required-field repairer.
 * Verifies that missing required CloudFormation fields are filled from plugin defaults.
 *
 * @see Story E2E.3
 */

import { describe, it, expect } from "vitest";
import { repairRequiredFields } from "./required-field-repairer.js";

describe("repairRequiredFields", () => {
  describe("Lambda Function — Code from plugin defaults", () => {
    it("injects Code when missing from desiredState", () => {
      const desiredState = {
        FunctionName: "my-fn",
        Runtime: "nodejs22.x",
        Handler: "index.handler",
      };
      const { repaired, injectedFields } = repairRequiredFields(
        desiredState,
        "AWS::Lambda::Function",
        ["FunctionName", "Code"],
      );

      // Tier C: dropped redundant toBeDefined() — the next assertion
      // (.ZipFile access through cast) fails on undefined
      expect(
        (repaired["Code"] as Record<string, unknown>)["ZipFile"],
      ).toContain("exports.handler");
      expect(injectedFields).toContainEqual({
        field: "Code",
        source: "pluginDefault",
      });
    });

    it("does NOT override existing Code", () => {
      const desiredState = {
        FunctionName: "my-fn",
        Code: { S3Bucket: "my-bucket", S3Key: "code.zip" },
      };
      const { repaired, injectedFields } = repairRequiredFields(
        desiredState,
        "AWS::Lambda::Function",
        ["FunctionName", "Code"],
      );

      expect((repaired["Code"] as Record<string, unknown>)["S3Bucket"]).toBe(
        "my-bucket",
      );
      expect(injectedFields).toHaveLength(0);
    });
  });

  describe("SSM Parameter — fills from initialValue", () => {
    it("injects Type from plugin initialValue when missing", () => {
      const desiredState = {
        Name: "/my/param",
        Value: "test",
      };
      const { repaired, injectedFields } = repairRequiredFields(
        desiredState,
        "AWS::SSM::Parameter",
        ["Name", "Type", "Value"],
      );

      expect(repaired["Type"]).toBe("String");
      expect(injectedFields).toContainEqual({
        field: "Type",
        source: "initialValue",
      });
    });

    it("does not inject Name or Value (no plugin defaults for user-provided fields)", () => {
      const desiredState = {};
      const { repaired, injectedFields } = repairRequiredFields(
        desiredState,
        "AWS::SSM::Parameter",
        ["Name", "Type", "Value"],
      );

      // Type has initialValue "String", but Name and Value have no defaults
      expect(repaired["Type"]).toBe("String");
      expect(repaired["Name"]).toBeUndefined();
      expect(repaired["Value"]).toBeUndefined();
      expect(injectedFields).toHaveLength(1); // only Type
    });
  });

  describe("CloudWatch Alarm — fills multiple defaults", () => {
    it("injects ComparisonOperator from initialValue", () => {
      const desiredState = {
        AlarmName: "my-alarm",
        MetricName: "CPUUtilization",
        Namespace: "AWS/EC2",
        Threshold: 80,
      };
      const { repaired, injectedFields } = repairRequiredFields(
        desiredState,
        "AWS::CloudWatch::Alarm",
        [
          "AlarmName",
          "MetricName",
          "Namespace",
          "ComparisonOperator",
          "Threshold",
        ],
      );

      expect(repaired["ComparisonOperator"]).toBe("GreaterThanThreshold");
      expect(injectedFields.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("no-op cases", () => {
    it("returns unchanged when all required fields present", () => {
      const desiredState = {
        BucketName: "my-bucket",
      };
      const { repaired, injectedFields } = repairRequiredFields(
        desiredState,
        "AWS::S3::Bucket",
        ["BucketName"],
      );

      expect(repaired).toEqual(desiredState);
      expect(injectedFields).toHaveLength(0);
    });

    it("returns unchanged when plugin not found", () => {
      const desiredState = { Key: "value" };
      const { repaired, injectedFields } = repairRequiredFields(
        desiredState,
        "AWS::Unknown::Type",
        ["Key"],
      );

      expect(repaired).toEqual(desiredState);
      expect(injectedFields).toHaveLength(0);
    });

    it("returns unchanged when schemaRequired is empty", () => {
      const desiredState = { Key: "value" };
      const { repaired, injectedFields } = repairRequiredFields(
        desiredState,
        "AWS::S3::Bucket",
        [],
      );

      expect(repaired).toEqual(desiredState);
      expect(injectedFields).toHaveLength(0);
    });

    it("returns unchanged when resourceType is empty", () => {
      const desiredState = { Key: "value" };
      const { repaired } = repairRequiredFields(desiredState, "", ["Key"]);
      expect(repaired).toEqual(desiredState);
    });
  });

  describe("does NOT override existing values (AC #4)", () => {
    it("preserves user-provided field even if plugin has different default", () => {
      const desiredState = {
        Name: "/custom/path",
        Type: "SecureString", // user chose SecureString, not the default "String"
        Value: "my-secret",
      };
      const { repaired } = repairRequiredFields(
        desiredState,
        "AWS::SSM::Parameter",
        ["Name", "Type", "Value"],
      );

      expect(repaired["Type"]).toBe("SecureString");
    });
  });

  describe("ECR Repository", () => {
    it("does not inject RepositoryName (no plugin default for user-provided names)", () => {
      // RepositoryName is required but has no initialValue or plugin default —
      // it must come from the user's intent. The repairer correctly skips it.
      const desiredState = {};
      const { repaired, injectedFields } = repairRequiredFields(
        desiredState,
        "AWS::ECR::Repository",
        ["RepositoryName"],
      );

      // RepositoryName has no default — repairer can't fill it
      // This is correct: preflight should catch it
      expect(repaired["RepositoryName"]).toBeUndefined();
      expect(
        injectedFields.filter((f) => f.field === "RepositoryName"),
      ).toHaveLength(0);
    });
  });

  describe("DynamoDB Table", () => {
    it("injects BillingMode from plugin defaults when missing", () => {
      const desiredState = {
        TableName: "my-table",
        KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
        AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }],
      };
      // Note: BillingMode is not always schema-required, but if it is:
      const { repaired } = repairRequiredFields(
        desiredState,
        "AWS::DynamoDB::Table",
        ["TableName", "KeySchema", "AttributeDefinitions", "BillingMode"],
      );

      // BillingMode has initialValue "PAY_PER_REQUEST"
      expect(repaired["BillingMode"]).toBe("PAY_PER_REQUEST");
    });
  });
});

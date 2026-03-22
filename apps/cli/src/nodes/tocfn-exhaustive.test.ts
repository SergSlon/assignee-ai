/**
 * Exhaustive test: verifies every field in every ResourcePlugin produces
 * correct CloudFormation output for all answer variants (true/false/string/enum).
 */
import { describe, it, expect } from "vitest";
import { defaultPluginRegistry } from "@assignee/core";
import { applyToCfnTransforms } from "./plan-generator.js";

const PLUGIN_TYPES = [
  "AWS::S3::Bucket",
  "AWS::EC2::Instance",
  "AWS::RDS::DBInstance",
  "AWS::Lambda::Function",
];

describe("applyToCfnTransforms — exhaustive field coverage", () => {
  for (const resourceType of PLUGIN_TYPES) {
    const plugin = defaultPluginRegistry.get(resourceType);
    if (!plugin) continue;

    const allFields = [...plugin.commonFields, ...plugin.advancedFields];

    describe(resourceType, () => {
      for (const field of allFields) {
        const hasToCfn = !!field.toCfn;

        if (field.question.type === "boolean") {
          it(`${field.name} (true) → ${hasToCfn ? "CFN object" : "passthrough true"}`, () => {
            const result = applyToCfnTransforms(
              { [field.name]: true },
              resourceType,
            );
            if (hasToCfn) {
              // toCfn(true) should produce a non-boolean object
              expect(result[field.name]).not.toBe(true);
              expect(result[field.name]).toBeDefined();
              expect(typeof result[field.name]).toBe("object");
            } else {
              // No transform — boolean passes through
              expect(result[field.name]).toBe(true);
            }
          });

          it(`${field.name} (false) → ${hasToCfn ? "omitted" : "passthrough false"}`, () => {
            const result = applyToCfnTransforms(
              { [field.name]: false },
              resourceType,
            );
            if (hasToCfn) {
              // toCfn(false) should return undefined → field omitted
              expect(result[field.name]).toBeUndefined();
            } else {
              // No transform — boolean passes through
              expect(result[field.name]).toBe(false);
            }
          });
        }

        if (field.question.type === "string") {
          it(`${field.name} (string value) → passthrough`, () => {
            const result = applyToCfnTransforms(
              { [field.name]: "test-value-123" },
              resourceType,
            );
            expect(result[field.name]).toBe("test-value-123");
          });
        }

        if (field.question.type === "enum" && field.question.options?.length) {
          for (const opt of field.question.options) {
            it(`${field.name} (enum "${opt.value}") → passthrough`, () => {
              const result = applyToCfnTransforms(
                { [field.name]: opt.value },
                resourceType,
              );
              expect(result[field.name]).toBe(opt.value);
            });
          }
        }
      }
    });
  }

  // === S3-specific structural assertions ===

  describe("S3 toCfn structural correctness", () => {
    it("BucketEncryption (true) → valid SSE-S3 AES256 structure", () => {
      const result = applyToCfnTransforms(
        { BucketEncryption: true },
        "AWS::S3::Bucket",
      );
      expect(result["BucketEncryption"]).toEqual({
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
        ],
      });
    });

    it("PublicAccessBlockConfiguration (true) → 4-field block object", () => {
      const result = applyToCfnTransforms(
        { PublicAccessBlockConfiguration: true },
        "AWS::S3::Bucket",
      );
      expect(result["PublicAccessBlockConfiguration"]).toEqual({
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      });
    });

    it("VersioningConfiguration (true) → { Status: 'Enabled' }", () => {
      const result = applyToCfnTransforms(
        { VersioningConfiguration: true },
        "AWS::S3::Bucket",
      );
      expect(result["VersioningConfiguration"]).toEqual({ Status: "Enabled" });
    });

    it("LifecycleConfiguration (true) → transition rule", () => {
      const result = applyToCfnTransforms(
        { LifecycleConfiguration: true },
        "AWS::S3::Bucket",
      );
      const lc = result["LifecycleConfiguration"] as Record<string, unknown>;
      expect(lc).toHaveProperty("Rules");
      expect(Array.isArray((lc as { Rules: unknown[] }).Rules)).toBe(true);
    });

    it("CorsConfiguration (true) → CorsRules array", () => {
      const result = applyToCfnTransforms(
        { CorsConfiguration: true },
        "AWS::S3::Bucket",
      );
      const cors = result["CorsConfiguration"] as Record<string, unknown>;
      expect(cors).toHaveProperty("CorsRules");
    });

    it("All S3 booleans false → all omitted from result", () => {
      const result = applyToCfnTransforms(
        {
          BucketEncryption: false,
          PublicAccessBlockConfiguration: false,
          VersioningConfiguration: false,
          LifecycleConfiguration: false,
          CorsConfiguration: false,
        },
        "AWS::S3::Bucket",
      );
      expect(result["BucketEncryption"]).toBeUndefined();
      expect(result["PublicAccessBlockConfiguration"]).toBeUndefined();
      expect(result["VersioningConfiguration"]).toBeUndefined();
      expect(result["LifecycleConfiguration"]).toBeUndefined();
      expect(result["CorsConfiguration"]).toBeUndefined();
    });

    it("All S3 booleans true → all produce objects", () => {
      const result = applyToCfnTransforms(
        {
          BucketEncryption: true,
          PublicAccessBlockConfiguration: true,
          VersioningConfiguration: true,
          LifecycleConfiguration: true,
          CorsConfiguration: true,
        },
        "AWS::S3::Bucket",
      );
      expect(typeof result["BucketEncryption"]).toBe("object");
      expect(typeof result["PublicAccessBlockConfiguration"]).toBe("object");
      expect(typeof result["VersioningConfiguration"]).toBe("object");
      expect(typeof result["LifecycleConfiguration"]).toBe("object");
      expect(typeof result["CorsConfiguration"]).toBe("object");
    });

    it("String fields pass through unchanged alongside boolean transforms", () => {
      const result = applyToCfnTransforms(
        {
          BucketName: "my-test-bucket",
          BucketEncryption: true,
          ReplicationConfiguration: false,
        },
        "AWS::S3::Bucket",
      );
      expect(result["BucketName"]).toBe("my-test-bucket");
      expect(typeof result["BucketEncryption"]).toBe("object");
      // ReplicationConfiguration has no toCfn → passes through as false
      expect(result["ReplicationConfiguration"]).toBe(false);
    });
  });

  // === RDS boolean passthrough ===
  describe("RDS boolean passthrough (native CFN booleans)", () => {
    it("MultiAZ (true) → passes through as boolean (native CFN)", () => {
      const result = applyToCfnTransforms(
        { MultiAZ: true },
        "AWS::RDS::DBInstance",
      );
      expect(result["MultiAZ"]).toBe(true);
    });

    it("DeletionProtection (true) → passes through as boolean", () => {
      const result = applyToCfnTransforms(
        { DeletionProtection: true },
        "AWS::RDS::DBInstance",
      );
      expect(result["DeletionProtection"]).toBe(true);
    });
  });

  // === Unknown resource type ===
  describe("Unknown resource type", () => {
    it("returns options unchanged when no plugin exists", () => {
      const input = { SomeField: true, Another: "hello" };
      const result = applyToCfnTransforms(input, "AWS::Custom::Unknown");
      expect(result).toEqual(input);
    });
  });
});

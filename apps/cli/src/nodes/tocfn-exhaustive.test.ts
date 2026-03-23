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

/**
 * S3 composite sub-fields that are consumed by assembleS3Composites()
 * and deleted from the result. These must be tested separately as composites,
 * not as individual passthrough fields.
 */
const S3_COMPOSITE_SUB_FIELDS = new Set([
  "BucketEncryption",
  "KMSMasterKeyID",
  "EnableLifecycle",
  "LifecycleTransitionDays",
  "LifecycleExpirationDays",
  "EnableCors",
  "CorsAllowedOrigins",
  "CorsAllowedMethods",
  "EnableReplication",
  "ReplicationDestinationBucket",
]);

describe("applyToCfnTransforms — exhaustive field coverage", () => {
  for (const resourceType of PLUGIN_TYPES) {
    const plugin = defaultPluginRegistry.get(resourceType);
    if (!plugin) continue;

    const allFields = [...plugin.commonFields, ...plugin.advancedFields];

    describe(resourceType, () => {
      for (const field of allFields) {
        // Skip S3 composite sub-fields — they are deleted by assembleS3Composites
        // and tested separately in the "S3 composite assembly" describe block below.
        if (
          resourceType === "AWS::S3::Bucket" &&
          S3_COMPOSITE_SUB_FIELDS.has(field.name)
        ) {
          continue;
        }

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
          if (field.toCfn) {
            it(`${field.name} (string value) → toCfn transform`, () => {
              const result = applyToCfnTransforms(
                { [field.name]: "test-value-123" },
                resourceType,
              );
              // Fields with toCfn may transform or omit the value (e.g., Tags → [{Key, Value}], Environment → {Variables: {...}} or undefined)
              // Simply verify it does NOT pass through unchanged as a raw string
              expect(result[field.name]).not.toBe("test-value-123");
            });
          } else {
            it(`${field.name} (string value) → passthrough`, () => {
              const result = applyToCfnTransforms(
                { [field.name]: "test-value-123" },
                resourceType,
              );
              expect(result[field.name]).toBe("test-value-123");
            });
          }
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

    it("All S3 toCfn booleans false → all omitted from result", () => {
      const result = applyToCfnTransforms(
        {
          BucketEncryption: false,
          PublicAccessBlockConfiguration: false,
          VersioningConfiguration: false,
          EnableLifecycle: false,
          EnableCors: false,
          EnableReplication: false,
        },
        "AWS::S3::Bucket",
      );
      expect(result["BucketEncryption"]).toBeUndefined();
      expect(result["PublicAccessBlockConfiguration"]).toBeUndefined();
      expect(result["VersioningConfiguration"]).toBeUndefined();
      expect(result["LifecycleConfiguration"]).toBeUndefined();
      expect(result["CorsConfiguration"]).toBeUndefined();
      expect(result["ReplicationConfiguration"]).toBeUndefined();
      // Intermediate keys must be removed
      expect(result["EnableLifecycle"]).toBeUndefined();
      expect(result["EnableCors"]).toBeUndefined();
      expect(result["EnableReplication"]).toBeUndefined();
    });

    it("All S3 features enabled → all produce objects", () => {
      const result = applyToCfnTransforms(
        {
          BucketEncryption: true,
          PublicAccessBlockConfiguration: true,
          VersioningConfiguration: true,
          EnableLifecycle: true,
          LifecycleTransitionDays: "60",
          LifecycleExpirationDays: "365",
          EnableCors: true,
          CorsAllowedOrigins: "https://example.com",
          CorsAllowedMethods: "GET,PUT",
          EnableReplication: true,
          ReplicationDestinationBucket: "arn:aws:s3:::replica",
        },
        "AWS::S3::Bucket",
      );
      expect(typeof result["BucketEncryption"]).toBe("object");
      expect(typeof result["PublicAccessBlockConfiguration"]).toBe("object");
      expect(typeof result["VersioningConfiguration"]).toBe("object");
      expect(typeof result["LifecycleConfiguration"]).toBe("object");
      expect(typeof result["CorsConfiguration"]).toBe("object");
      expect(typeof result["ReplicationConfiguration"]).toBe("object");
    });

    it("String fields pass through unchanged alongside boolean transforms", () => {
      const result = applyToCfnTransforms(
        {
          BucketName: "my-test-bucket",
          BucketEncryption: true,
          EnableReplication: false,
        },
        "AWS::S3::Bucket",
      );
      expect(result["BucketName"]).toBe("my-test-bucket");
      expect(typeof result["BucketEncryption"]).toBe("object");
      expect(result["ReplicationConfiguration"]).toBeUndefined();
      expect(result["EnableReplication"]).toBeUndefined();
    });
  });

  // === S3 composite assembly (sub-field → CFN structure) ===

  describe("S3 composite assembly", () => {
    it("Lifecycle: assembles LifecycleConfiguration from sub-fields", () => {
      const result = applyToCfnTransforms(
        {
          EnableLifecycle: true,
          LifecycleTransitionDays: "60",
          LifecycleExpirationDays: "365",
        },
        "AWS::S3::Bucket",
      );
      expect(result["LifecycleConfiguration"]).toEqual({
        Rules: [
          {
            Status: "Enabled",
            Transitions: [
              { StorageClass: "STANDARD_IA", TransitionInDays: 60 },
            ],
            ExpirationInDays: 365,
          },
        ],
      });
      // Intermediate keys must be deleted
      expect(result["EnableLifecycle"]).toBeUndefined();
      expect(result["LifecycleTransitionDays"]).toBeUndefined();
      expect(result["LifecycleExpirationDays"]).toBeUndefined();
    });

    it("Lifecycle: uses defaults when sub-fields are omitted", () => {
      const result = applyToCfnTransforms(
        { EnableLifecycle: true },
        "AWS::S3::Bucket",
      );
      expect(result["LifecycleConfiguration"]).toEqual({
        Rules: [
          {
            Status: "Enabled",
            Transitions: [
              { StorageClass: "STANDARD_IA", TransitionInDays: 30 },
            ],
          },
        ],
      });
    });

    it("Lifecycle: no CFN structure when EnableLifecycle is false", () => {
      const result = applyToCfnTransforms(
        { EnableLifecycle: false, LifecycleTransitionDays: "60" },
        "AWS::S3::Bucket",
      );
      expect(result["LifecycleConfiguration"]).toBeUndefined();
      expect(result["EnableLifecycle"]).toBeUndefined();
      expect(result["LifecycleTransitionDays"]).toBeUndefined();
    });

    it("CORS: assembles CorsConfiguration from sub-fields", () => {
      const result = applyToCfnTransforms(
        {
          EnableCors: true,
          CorsAllowedOrigins: "https://example.com",
          CorsAllowedMethods: "GET,PUT",
        },
        "AWS::S3::Bucket",
      );
      expect(result["CorsConfiguration"]).toEqual({
        CorsRules: [
          {
            AllowedMethods: ["GET", "PUT"],
            AllowedOrigins: ["https://example.com"],
          },
        ],
      });
      expect(result["EnableCors"]).toBeUndefined();
      expect(result["CorsAllowedOrigins"]).toBeUndefined();
      expect(result["CorsAllowedMethods"]).toBeUndefined();
    });

    it("CORS: no CFN structure when EnableCors is false", () => {
      const result = applyToCfnTransforms(
        { EnableCors: false, CorsAllowedOrigins: "https://example.com" },
        "AWS::S3::Bucket",
      );
      expect(result["CorsConfiguration"]).toBeUndefined();
      expect(result["EnableCors"]).toBeUndefined();
      expect(result["CorsAllowedOrigins"]).toBeUndefined();
    });

    it("Replication: assembles ReplicationConfiguration from sub-fields", () => {
      const result = applyToCfnTransforms(
        {
          EnableReplication: true,
          ReplicationDestinationBucket: "arn:aws:s3:::replica",
        },
        "AWS::S3::Bucket",
      );
      expect(result["ReplicationConfiguration"]).toEqual({
        Role: "",
        Rules: [
          {
            Status: "Enabled",
            Destination: { Bucket: "arn:aws:s3:::replica" },
          },
        ],
      });
      expect(result["EnableReplication"]).toBeUndefined();
      expect(result["ReplicationDestinationBucket"]).toBeUndefined();
    });

    it("Replication: no CFN structure when EnableReplication is false", () => {
      const result = applyToCfnTransforms(
        {
          EnableReplication: false,
          ReplicationDestinationBucket: "arn:aws:s3:::replica",
        },
        "AWS::S3::Bucket",
      );
      expect(result["ReplicationConfiguration"]).toBeUndefined();
      expect(result["EnableReplication"]).toBeUndefined();
      expect(result["ReplicationDestinationBucket"]).toBeUndefined();
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

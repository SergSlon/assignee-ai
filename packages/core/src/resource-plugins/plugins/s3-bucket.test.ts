import { describe, it, expect } from "vitest";
import { s3BucketPlugin } from "./s3-bucket.js";

describe("s3BucketPlugin", () => {
  it("has the correct resourceType", () => {
    expect(s3BucketPlugin.resourceType).toBe("AWS::S3::Bucket");
  });

  it("commonFields count is ≤10 (AC-6)", () => {
    expect(s3BucketPlugin.commonFields.length).toBeLessThanOrEqual(10);
  });

  it("commonFields count matches expected 6 fields", () => {
    expect(s3BucketPlugin.commonFields.length).toBe(6);
  });

  it("all commonField question types are valid QuestionType values", () => {
    const validTypes = new Set(["boolean", "enum", "string", "multi"]);
    for (const field of s3BucketPlugin.commonFields) {
      expect(validTypes.has(field.question.type)).toBe(true);
    }
  });

  it("KMSMasterKeyID has showIf conditional on BucketEncryption === true (AC-8)", () => {
    const kmsField = s3BucketPlugin.commonFields.find(
      (f) => f.name === "KMSMasterKeyID",
    );
    expect(kmsField).toBeDefined();
    expect(kmsField?.question.showIf).toEqual({
      field: "BucketEncryption",
      value: true,
    });
  });

  it("BucketName field exists in commonFields", () => {
    const field = s3BucketPlugin.commonFields.find(
      (f) => f.name === "BucketName",
    );
    expect(field).toBeDefined();
    expect(field?.question.type).toBe("string");
  });

  it("Tags field uses multi type", () => {
    const field = s3BucketPlugin.commonFields.find((f) => f.name === "Tags");
    expect(field).toBeDefined();
    expect(field?.question.type).toBe("multi");
  });

  it("defaults contain PublicAccessBlockConfiguration", () => {
    expect(
      s3BucketPlugin.defaults["PublicAccessBlockConfiguration"],
    ).toMatchObject({
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    });
  });

  it("advancedFields contains LifecycleConfiguration and CorsConfiguration", () => {
    const names = s3BucketPlugin.advancedFields.map((f) => f.name);
    expect(names).toContain("LifecycleConfiguration");
    expect(names).toContain("CorsConfiguration");
  });

  // Story 18.9 — toCfn transform tests
  describe("toCfn transforms", () => {
    const allFields = [
      ...s3BucketPlugin.commonFields,
      ...s3BucketPlugin.advancedFields,
    ];
    const findField = (name: string) => allFields.find((f) => f.name === name)!;

    describe("BucketEncryption", () => {
      const field = findField("BucketEncryption");

      it("transforms true to SSE-S3 structure", () => {
        expect(field.toCfn!(true)).toEqual({
          ServerSideEncryptionConfiguration: [
            { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
          ],
        });
      });

      it("transforms false to undefined", () => {
        expect(field.toCfn!(false)).toBeUndefined();
      });
    });

    describe("PublicAccessBlockConfiguration", () => {
      const field = findField("PublicAccessBlockConfiguration");

      it("transforms true to 4-field block", () => {
        expect(field.toCfn!(true)).toEqual({
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        });
      });

      it("transforms false to undefined", () => {
        expect(field.toCfn!(false)).toBeUndefined();
      });
    });

    describe("VersioningConfiguration", () => {
      const field = findField("VersioningConfiguration");

      it("transforms true to Status: Enabled", () => {
        expect(field.toCfn!(true)).toEqual({ Status: "Enabled" });
      });

      it("transforms false to undefined", () => {
        expect(field.toCfn!(false)).toBeUndefined();
      });
    });

    describe("LifecycleConfiguration", () => {
      const field = findField("LifecycleConfiguration");

      it("transforms true to default rule with STANDARD_IA transition", () => {
        expect(field.toCfn!(true)).toEqual({
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

      it("transforms false to undefined", () => {
        expect(field.toCfn!(false)).toBeUndefined();
      });
    });

    describe("CorsConfiguration", () => {
      const field = findField("CorsConfiguration");

      it("transforms true to permissive GET/* default", () => {
        expect(field.toCfn!(true)).toEqual({
          CorsRules: [{ AllowedMethods: ["GET"], AllowedOrigins: ["*"] }],
        });
      });

      it("transforms false to undefined", () => {
        expect(field.toCfn!(false)).toBeUndefined();
      });
    });

    describe("fields without toCfn", () => {
      it("BucketName has no toCfn", () => {
        expect(findField("BucketName").toCfn).toBeUndefined();
      });

      it("KMSMasterKeyID has no toCfn", () => {
        expect(findField("KMSMasterKeyID").toCfn).toBeUndefined();
      });

      it("Tags has no toCfn", () => {
        expect(findField("Tags").toCfn).toBeUndefined();
      });
    });
  });
});

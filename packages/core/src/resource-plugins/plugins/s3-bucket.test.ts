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

  describe("BucketName validation", () => {
    const field = s3BucketPlugin.commonFields.find(
      (f) => f.name === "BucketName",
    )!;

    it("accepts empty value (auto-generated)", () => {
      expect(field.question.validate?.("")).toBeUndefined();
    });

    it("accepts valid bucket name", () => {
      expect(field.question.validate?.("my-bucket-123")).toBeUndefined();
    });

    it("rejects too short name", () => {
      expect(field.question.validate?.("ab")).toBeDefined();
    });

    it("rejects too long name (>63 chars)", () => {
      expect(field.question.validate?.("a".repeat(64))).toBeDefined();
    });

    it("rejects uppercase letters", () => {
      expect(field.question.validate?.("MyBucket")).toBeDefined();
    });

    it("rejects consecutive periods", () => {
      expect(field.question.validate?.("my..bucket")).toBeDefined();
    });
  });

  it("Tags field is string type with toCfn transform", () => {
    const field = s3BucketPlugin.commonFields.find((f) => f.name === "Tags");
    expect(field).toBeDefined();
    expect(field?.question.type).toBe("string");
    expect(field?.toCfn).toBeDefined();
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

  it("advancedFields contains lifecycle and CORS sub-fields", () => {
    const names = s3BucketPlugin.advancedFields.map((f) => f.name);
    expect(names).toContain("EnableLifecycle");
    expect(names).toContain("LifecycleTransitionDays");
    expect(names).toContain("LifecycleExpirationDays");
    expect(names).toContain("EnableCors");
    expect(names).toContain("CorsAllowedOrigins");
    expect(names).toContain("CorsAllowedMethods");
    expect(names).toContain("EnableReplication");
    expect(names).toContain("ReplicationDestinationBucket");
  });

  it("lifecycle sub-fields have showIf on EnableLifecycle", () => {
    const transField = s3BucketPlugin.advancedFields.find(
      (f) => f.name === "LifecycleTransitionDays",
    );
    expect(transField?.question.showIf).toEqual({
      field: "EnableLifecycle",
      value: true,
    });

    const expField = s3BucketPlugin.advancedFields.find(
      (f) => f.name === "LifecycleExpirationDays",
    );
    expect(expField?.question.showIf).toEqual({
      field: "EnableLifecycle",
      value: true,
    });
  });

  it("CORS sub-fields have showIf on EnableCors", () => {
    const originsField = s3BucketPlugin.advancedFields.find(
      (f) => f.name === "CorsAllowedOrigins",
    );
    expect(originsField?.question.showIf).toEqual({
      field: "EnableCors",
      value: true,
    });

    const methodsField = s3BucketPlugin.advancedFields.find(
      (f) => f.name === "CorsAllowedMethods",
    );
    expect(methodsField?.question.showIf).toEqual({
      field: "EnableCors",
      value: true,
    });
  });

  it("replication destination has showIf on EnableReplication", () => {
    const destField = s3BucketPlugin.advancedFields.find(
      (f) => f.name === "ReplicationDestinationBucket",
    );
    expect(destField?.question.showIf).toEqual({
      field: "EnableReplication",
      value: true,
    });
  });

  // Story 18.9 — toCfn transform tests (commonFields only now)
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

    describe("advanced fields have no toCfn (assembled by plan-generator)", () => {
      it("EnableLifecycle has no toCfn", () => {
        expect(findField("EnableLifecycle").toCfn).toBeUndefined();
      });

      it("EnableCors has no toCfn", () => {
        expect(findField("EnableCors").toCfn).toBeUndefined();
      });

      it("EnableReplication has no toCfn", () => {
        expect(findField("EnableReplication").toCfn).toBeUndefined();
      });
    });

    describe("fields without toCfn", () => {
      it("BucketName has no toCfn", () => {
        expect(findField("BucketName").toCfn).toBeUndefined();
      });

      it("KMSMasterKeyID has no toCfn", () => {
        expect(findField("KMSMasterKeyID").toCfn).toBeUndefined();
      });

      it("Tags has toCfn", () => {
        expect(findField("Tags").toCfn).toBeDefined();
      });
    });
  });
});

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
    // Wave 16: strengthened — assert kmsField is the right object
    // (not just any non-undefined value).
    expect(kmsField?.name).toBe("KMSMasterKeyID");
    expect(kmsField?.question.showIf).toEqual({
      field: "BucketEncryption",
      value: true,
    });
  });

  it("BucketName field exists in commonFields", () => {
    const field = s3BucketPlugin.commonFields.find(
      (f) => f.name === "BucketName",
    );
    // Wave 16: strengthened — assert by name + type instead of bare existence.
    expect(field?.name).toBe("BucketName");
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

    // Wave 16: strengthened the four bucket-name validation tests below
    // to assert the validator returns a non-empty STRING error message,
    // not just any non-undefined value. The previous `toBeDefined()`
    // would have passed for `0`, `false`, an empty string, or any
    // other "non-undefined" return value — none of which a wizard
    // prompt could meaningfully display to the user.
    it("rejects too short name", () => {
      const err = field.question.validate?.("ab");
      expect(typeof err).toBe("string");
      expect((err as string).length).toBeGreaterThan(0);
    });

    it("rejects too long name (>63 chars)", () => {
      const err = field.question.validate?.("a".repeat(64));
      expect(typeof err).toBe("string");
      expect((err as string).length).toBeGreaterThan(0);
    });

    it("rejects uppercase letters", () => {
      const err = field.question.validate?.("MyBucket");
      expect(typeof err).toBe("string");
      expect((err as string).length).toBeGreaterThan(0);
    });

    it("rejects consecutive periods", () => {
      const err = field.question.validate?.("my..bucket");
      expect(typeof err).toBe("string");
      expect((err as string).length).toBeGreaterThan(0);
    });
  });

  it("Tags field is string type with toCfn transform", () => {
    const field = s3BucketPlugin.commonFields.find((f) => f.name === "Tags");
    // Wave 16: strengthened — assert by name + that toCfn is callable.
    expect(field?.name).toBe("Tags");
    expect(field?.question.type).toBe("string");
    expect(typeof field?.toCfn).toBe("function");
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

      it("has no toCfn (encryption is assembled by assembleS3Composites)", () => {
        expect(field.toCfn).toBeUndefined();
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
        // Wave 16: strengthened — assert toCfn is callable, not just defined.
        expect(typeof findField("Tags").toCfn).toBe("function");
      });
    });
  });
});

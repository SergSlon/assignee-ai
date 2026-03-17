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
});

import { describe, it, expect } from "vitest";
import { ecrRepositoryPlugin } from "./ecr-repository.js";

describe("ecrRepositoryPlugin", () => {
  it("has the correct resourceType", () => {
    expect(ecrRepositoryPlugin.resourceType).toBe("AWS::ECR::Repository");
  });

  it("commonFields count is ≤10", () => {
    expect(ecrRepositoryPlugin.commonFields.length).toBeLessThanOrEqual(10);
  });

  it("commonFields count is 4", () => {
    expect(ecrRepositoryPlugin.commonFields.length).toBe(4);
  });

  it("all commonField question types are valid", () => {
    const validTypes = new Set(["boolean", "enum", "string", "multi"]);
    for (const field of ecrRepositoryPlugin.commonFields) {
      expect(validTypes.has(field.question.type)).toBe(true);
    }
  });

  describe("RepositoryName validation", () => {
    const field = ecrRepositoryPlugin.commonFields.find(
      (f) => f.name === "RepositoryName",
    )!;

    it("is required", () => {
      expect(field.required).toBe(true);
    });

    it("rejects empty value", () => {
      expect(field.question.validate?.("")).toBeDefined();
    });

    it("accepts valid repository name", () => {
      expect(field.question.validate?.("my-app")).toBeUndefined();
    });

    it("accepts namespaced repository name", () => {
      expect(field.question.validate?.("team/my-app")).toBeUndefined();
    });

    it("rejects names shorter than 2 chars", () => {
      expect(field.question.validate?.("a")).toBeDefined();
    });

    it("rejects names longer than 256 chars", () => {
      expect(field.question.validate?.("a".repeat(257))).toBeDefined();
    });

    it("rejects names with uppercase", () => {
      expect(field.question.validate?.("MyApp")).toBeDefined();
    });
  });

  it("ImageTagMutability defaults to IMMUTABLE", () => {
    const field = ecrRepositoryPlugin.commonFields.find(
      (f) => f.name === "ImageTagMutability",
    );
    expect(field?.question.type).toBe("enum");
    expect(field?.question.initialValue).toBe("IMMUTABLE");
    expect(field?.question.options).toHaveLength(2);
  });

  it("ScanOnPush defaults to true", () => {
    const field = ecrRepositoryPlugin.commonFields.find(
      (f) => f.name === "ScanOnPush",
    );
    expect(field?.question.type).toBe("boolean");
    expect(field?.question.initialValue).toBe(true);
  });

  describe("ScanOnPush toCfn transform", () => {
    const field = ecrRepositoryPlugin.commonFields.find(
      (f) => f.name === "ScanOnPush",
    )!;

    it("returns ScanOnPush true when enabled", () => {
      expect(field.toCfn!(true)).toEqual({ ScanOnPush: true });
    });

    it("returns ScanOnPush false when disabled", () => {
      expect(field.toCfn!(false)).toEqual({ ScanOnPush: false });
    });
  });

  it("Tags field has toCfn transform", () => {
    const field = ecrRepositoryPlugin.commonFields.find(
      (f) => f.name === "Tags",
    );
    expect(field?.toCfn).toBeDefined();
  });

  describe("Tags toCfn transform", () => {
    const field = ecrRepositoryPlugin.commonFields.find(
      (f) => f.name === "Tags",
    )!;

    it("converts comma-separated Key:Value pairs", () => {
      expect(field.toCfn!("env:prod, team:backend")).toEqual([
        { Key: "env", Value: "prod" },
        { Key: "team", Value: "backend" },
      ]);
    });

    it("returns undefined for empty string", () => {
      expect(field.toCfn!("")).toBeUndefined();
    });
  });

  it("advancedFields contains EncryptionType, KmsKey, and LifecyclePolicyText", () => {
    const names = ecrRepositoryPlugin.advancedFields.map((f) => f.name);
    expect(names).toContain("EncryptionType");
    expect(names).toContain("KmsKey");
    expect(names).toContain("LifecyclePolicyText");
  });

  it("KmsKey has showIf condition on EncryptionType=KMS", () => {
    const field = ecrRepositoryPlugin.advancedFields.find(
      (f) => f.name === "KmsKey",
    );
    expect(field?.question.showIf).toEqual({
      field: "EncryptionType",
      value: "KMS",
    });
  });

  describe("KmsKey validation", () => {
    const field = ecrRepositoryPlugin.advancedFields.find(
      (f) => f.name === "KmsKey",
    )!;

    it("accepts empty value", () => {
      expect(field.question.validate?.("")).toBeUndefined();
    });

    it("accepts valid KMS ARN", () => {
      expect(
        field.question.validate?.("arn:aws:kms:us-east-1:123456789012:key/abc"),
      ).toBeUndefined();
    });

    it("rejects invalid ARN", () => {
      expect(field.question.validate?.("not-a-kms-arn")).toBeDefined();
    });
  });

  it("defaults include ImageTagMutability and ImageScanningConfiguration", () => {
    expect(ecrRepositoryPlugin.defaults).toEqual({
      ImageTagMutability: "IMMUTABLE",
      ImageScanningConfiguration: { ScanOnPush: true },
    });
  });
});

import { describe, it, expect } from "vitest";
import { secretsManagerSecretPlugin } from "./secretsmanager-secret.js";

describe("secretsManagerSecretPlugin", () => {
  it("has the correct resourceType", () => {
    expect(secretsManagerSecretPlugin.resourceType).toBe(
      "AWS::SecretsManager::Secret",
    );
  });

  it("commonFields count is 5", () => {
    expect(secretsManagerSecretPlugin.commonFields.length).toBe(5);
  });

  it("commonFields count is ≤10", () => {
    expect(secretsManagerSecretPlugin.commonFields.length).toBeLessThanOrEqual(
      10,
    );
  });

  it("commonFields have expected names in order", () => {
    const names = secretsManagerSecretPlugin.commonFields.map((f) => f.name);
    expect(names).toEqual([
      "Name",
      "Description",
      "GenerateSecretString",
      "KmsKeyId",
      "Tags",
    ]);
  });

  it("Name is required", () => {
    const field = secretsManagerSecretPlugin.commonFields.find(
      (f) => f.name === "Name",
    );
    expect(field?.required).toBe(true);
  });

  describe("Name validation", () => {
    const field = secretsManagerSecretPlugin.commonFields.find(
      (f) => f.name === "Name",
    )!;

    it("rejects empty value", () => {
      expect(field.question.validate?.("")).toBeDefined();
    });

    it("accepts valid secret name", () => {
      expect(
        field.question.validate?.("my-app/production/db-password"),
      ).toBeUndefined();
    });

    it("rejects names longer than 512 chars", () => {
      expect(field.question.validate?.("a".repeat(513))).toBeDefined();
    });

    it("rejects names with invalid characters", () => {
      expect(field.question.validate?.("my secret!")).toBeDefined();
    });
  });

  it("GenerateSecretString defaults to true (boolean)", () => {
    const field = secretsManagerSecretPlugin.commonFields.find(
      (f) => f.name === "GenerateSecretString",
    );
    expect(field?.question.type).toBe("boolean");
    expect(field?.question.initialValue).toBe(true);
  });

  it("KmsKeyId defaults to empty (AWS auto-uses default key)", () => {
    const field = secretsManagerSecretPlugin.commonFields.find(
      (f) => f.name === "KmsKeyId",
    );
    expect(field?.question.initialValue).toBe("");
  });

  describe("KmsKeyId validation", () => {
    const field = secretsManagerSecretPlugin.commonFields.find(
      (f) => f.name === "KmsKeyId",
    )!;

    it("accepts aws/secretsmanager", () => {
      expect(field.question.validate?.("aws/secretsmanager")).toBeUndefined();
    });

    it("accepts KMS ARN", () => {
      expect(
        field.question.validate?.("arn:aws:kms:us-east-1:123456:key/abc-123"),
      ).toBeUndefined();
    });

    it("accepts alias", () => {
      expect(field.question.validate?.("alias/my-key")).toBeUndefined();
    });

    it("rejects invalid values", () => {
      expect(field.question.validate?.("random-string")).toBeDefined();
    });

    it("accepts empty/undefined (optional)", () => {
      expect(field.question.validate?.("")).toBeUndefined();
    });
  });

  it("advancedFields count is 3", () => {
    expect(secretsManagerSecretPlugin.advancedFields.length).toBe(3);
  });

  it("advancedFields have expected names", () => {
    const names = secretsManagerSecretPlugin.advancedFields.map((f) => f.name);
    expect(names).toEqual([
      "SecretString",
      "GenerateSecretStringConfig",
      "ReplicaRegions",
    ]);
  });

  it("SecretString has showIf on GenerateSecretString === false", () => {
    const field = secretsManagerSecretPlugin.advancedFields.find(
      (f) => f.name === "SecretString",
    );
    expect(field?.question.showIf).toEqual({
      field: "GenerateSecretString",
      value: false,
    });
  });

  it("GenerateSecretStringConfig has showIf on GenerateSecretString === true", () => {
    const field = secretsManagerSecretPlugin.advancedFields.find(
      (f) => f.name === "GenerateSecretStringConfig",
    );
    expect(field?.question.showIf).toEqual({
      field: "GenerateSecretString",
      value: true,
    });
  });

  describe("SecretString validation", () => {
    const field = secretsManagerSecretPlugin.advancedFields.find(
      (f) => f.name === "SecretString",
    )!;

    it("rejects empty value", () => {
      expect(field.question.validate?.("")).toBeDefined();
    });

    it("accepts non-empty value", () => {
      expect(field.question.validate?.("my-secret-value")).toBeUndefined();
    });

    it("rejects values over 65536 chars", () => {
      expect(field.question.validate?.("x".repeat(65537))).toBeDefined();
    });
  });

  describe("GenerateSecretStringConfig validation", () => {
    const field = secretsManagerSecretPlugin.advancedFields.find(
      (f) => f.name === "GenerateSecretStringConfig",
    )!;

    it("accepts valid JSON", () => {
      expect(
        field.question.validate?.('{"PasswordLength":32}'),
      ).toBeUndefined();
    });

    it("rejects invalid JSON", () => {
      expect(field.question.validate?.("not json")).toBeDefined();
    });

    it("accepts empty/undefined (optional)", () => {
      expect(field.question.validate?.("")).toBeUndefined();
    });
  });

  it("defaults include GenerateSecretString (KmsKeyId removed — AWS auto-uses default key)", () => {
    expect(secretsManagerSecretPlugin.defaults).toEqual({
      GenerateSecretString: true,
    });
  });

  it("configHints is a non-empty array", () => {
    expect(secretsManagerSecretPlugin.configHints).toBeDefined();
    expect(secretsManagerSecretPlugin.configHints!.length).toBeGreaterThan(0);
  });

  it("configHints mention GenerateSecretString, KMS, and rotation", () => {
    const hints = secretsManagerSecretPlugin.configHints!.join(" ");
    expect(hints).toContain("GenerateSecretString");
    expect(hints).toContain("KMS");
    expect(hints).toContain("rotation");
  });

  it("Tags field has toCfn transform", () => {
    const field = secretsManagerSecretPlugin.commonFields.find(
      (f) => f.name === "Tags",
    );
    expect(field?.toCfn).toBeDefined();
  });

  it("Tags toCfn transforms comma-separated pairs", () => {
    const field = secretsManagerSecretPlugin.commonFields.find(
      (f) => f.name === "Tags",
    )!;
    const result = field.toCfn!("env:production, team:backend");
    expect(result).toEqual([
      { Key: "env", Value: "production" },
      { Key: "team", Value: "backend" },
    ]);
  });

  it("GenerateSecretString toCfn returns config when true", () => {
    const field = secretsManagerSecretPlugin.commonFields.find(
      (f) => f.name === "GenerateSecretString",
    )!;
    const result = field.toCfn!(true);
    expect(result).toEqual({ PasswordLength: 32, ExcludePunctuation: false });
  });

  it("GenerateSecretString toCfn returns undefined when false", () => {
    const field = secretsManagerSecretPlugin.commonFields.find(
      (f) => f.name === "GenerateSecretString",
    )!;
    const result = field.toCfn!(false);
    expect(result).toBeUndefined();
  });

  it("ReplicaRegions toCfn transforms comma-separated regions", () => {
    const field = secretsManagerSecretPlugin.advancedFields.find(
      (f) => f.name === "ReplicaRegions",
    )!;
    const result = field.toCfn!("us-west-2, eu-west-1");
    expect(result).toEqual([{ Region: "us-west-2" }, { Region: "eu-west-1" }]);
  });
});

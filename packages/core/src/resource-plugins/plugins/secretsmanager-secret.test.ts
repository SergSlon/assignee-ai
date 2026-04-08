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

    it("rejects empty value with 'required' error", () => {
      // Tier C: strengthened from toBeDefined()
      expect(field.question.validate?.("")).toBe("Secret name is required");
    });

    it("accepts valid secret name", () => {
      expect(
        field.question.validate?.("my-app/production/db-password"),
      ).toBeUndefined();
    });

    it("rejects names longer than 512 chars with length error", () => {
      // Tier C: strengthened from toBeDefined()
      expect(field.question.validate?.("a".repeat(513))).toBe(
        "Secret name must be 512 characters or fewer",
      );
    });

    it("accepts exactly 512 chars (boundary)", () => {
      // Tier C: new boundary test
      expect(field.question.validate?.("a".repeat(512))).toBeUndefined();
    });

    it("rejects names with invalid characters with charset error", () => {
      // Tier C: strengthened from toBeDefined()
      expect(field.question.validate?.("my secret!")).toBe(
        "Secret name can only contain alphanumeric characters, /, _, +, =, ., @, and -",
      );
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

    it("rejects invalid values with KMS-format error", () => {
      // Tier C: strengthened from toBeDefined()
      expect(field.question.validate?.("random-string")).toBe(
        "Must be 'aws/secretsmanager', a KMS key ARN, or a key alias (alias/...)",
      );
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

    it("rejects empty value with 'required when not auto-generate' error", () => {
      // Tier C: strengthened from toBeDefined()
      expect(field.question.validate?.("")).toBe(
        "Secret value is required when not using auto-generate",
      );
    });

    it("accepts non-empty value", () => {
      expect(field.question.validate?.("my-secret-value")).toBeUndefined();
    });

    it("rejects values over 65536 chars with length error", () => {
      // Tier C: strengthened from toBeDefined()
      expect(field.question.validate?.("x".repeat(65537))).toBe(
        "Secret value must be 65536 characters or fewer",
      );
    });

    it("accepts exactly 65536 chars (boundary)", () => {
      // Tier C: new boundary test
      expect(field.question.validate?.("x".repeat(65536))).toBeUndefined();
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

    it("rejects invalid JSON with 'must be valid JSON' error", () => {
      // Tier C: strengthened from toBeDefined()
      expect(field.question.validate?.("not json")).toBe("Must be valid JSON");
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

  it("configHints has at least 3 entries (Tier C: was toBeDefined+>0)", () => {
    // Tier C: strengthened — meaningful floor
    expect(secretsManagerSecretPlugin.configHints).toBeInstanceOf(Array);
    expect(
      secretsManagerSecretPlugin.configHints!.length,
    ).toBeGreaterThanOrEqual(3);
  });

  it("configHints mention GenerateSecretString, KMS, and rotation", () => {
    const hints = secretsManagerSecretPlugin.configHints!.join(" ");
    expect(hints).toContain("GenerateSecretString");
    expect(hints).toContain("KMS");
    expect(hints).toContain("rotation");
  });

  it("Tags field has callable toCfn transform", () => {
    // Tier C: strengthened — find!() + assert function-ness
    const field = secretsManagerSecretPlugin.commonFields.find(
      (f) => f.name === "Tags",
    )!;
    expect(typeof field.toCfn).toBe("function");
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

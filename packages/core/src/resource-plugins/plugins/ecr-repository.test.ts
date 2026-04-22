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

    it("rejects empty value with 'required' error", () => {
      expect(field.question.validate?.("")).toBe("Repository name is required");
    });

    it("accepts valid repository name", () => {
      expect(field.question.validate?.("my-app")).toBeUndefined();
    });

    it("accepts namespaced repository name", () => {
      expect(field.question.validate?.("team/my-app")).toBeUndefined();
    });

    it("rejects names shorter than 2 chars with length error", () => {
      expect(field.question.validate?.("a")).toBe(
        "Repository name must be 2-256 characters",
      );
    });

    it("rejects names longer than 256 chars with length error", () => {
      expect(field.question.validate?.("a".repeat(257))).toBe(
        "Repository name must be 2-256 characters",
      );
    });

    it("accepts exactly 256 chars (boundary)", () => {
      expect(field.question.validate?.("a".repeat(256))).toBeUndefined();
    });

    it("accepts exactly 2 chars (lower boundary)", () => {
      expect(field.question.validate?.("ab")).toBeUndefined();
    });

    it("rejects names with uppercase with charset error", () => {
      expect(field.question.validate?.("MyApp")).toBe(
        "Must start with lowercase letter/number and contain only lowercase letters, numbers, hyphens, underscores, forward slashes, and periods",
      );
    });
  });

  describe("RepositoryName toCfn auto-generation (Epic 92 Wave 4.b / C-22)", () => {
    const field = ecrRepositoryPlugin.commonFields.find(
      (f) => f.name === "RepositoryName",
    )!;
    const AUTO_NAME_PATTERN = /^assignee-ecr-repository-[0-9a-f]{8}$/;

    it("auto-generates assignee-ecr-repository-<8hex> on empty input", () => {
      const result = field.toCfn!("");
      expect(typeof result).toBe("string");
      expect(result as string).toMatch(AUTO_NAME_PATTERN);
    });

    it("auto-generates on whitespace-only input", () => {
      expect(field.toCfn!("   ") as string).toMatch(AUTO_NAME_PATTERN);
    });

    it("auto-generates on undefined input", () => {
      expect(field.toCfn!(undefined) as string).toMatch(AUTO_NAME_PATTERN);
    });

    it("replaces the literal placeholder 'my-app' (LLM echo guard)", () => {
      expect(field.toCfn!("my-app") as string).toMatch(AUTO_NAME_PATTERN);
    });

    it("replaces common placeholders (example-repo / my-repository / my-ecr-repo)", () => {
      expect(field.toCfn!("example-repo") as string).toMatch(AUTO_NAME_PATTERN);
      expect(field.toCfn!("my-repository") as string).toMatch(
        AUTO_NAME_PATTERN,
      );
      expect(field.toCfn!("my-ecr-repo") as string).toMatch(AUTO_NAME_PATTERN);
      expect(field.toCfn!("example-repository") as string).toMatch(
        AUTO_NAME_PATTERN,
      );
    });

    it("preserves user-specified names unchanged", () => {
      expect(field.toCfn!("payments-api")).toBe("payments-api");
      expect(field.toCfn!("team/backend-service")).toBe("team/backend-service");
    });

    it("returns a different auto-name on each call (crypto.randomBytes)", () => {
      const a = field.toCfn!("");
      const b = field.toCfn!("");
      expect(a).not.toBe(b);
    });

    it("generated names satisfy the RepositoryName validator (round-trip)", () => {
      const validate = field.question.validate!;
      for (let i = 0; i < 5; i++) {
        const name = field.toCfn!("") as string;
        expect(validate(name)).toBeUndefined();
      }
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

  it("Tags field has callable toCfn transform", () => {
    const field = ecrRepositoryPlugin.commonFields.find(
      (f) => f.name === "Tags",
    )!;
    expect(typeof field.toCfn).toBe("function");
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

    it("rejects invalid ARN with KMS-format error", () => {
      expect(field.question.validate?.("not-a-kms-arn")).toBe(
        "Must be a KMS key ARN (arn:aws:kms:...)",
      );
    });
  });

  it("defaults include ImageTagMutability and ImageScanningConfiguration", () => {
    // Epic 92 Wave 4.b (C-22): RepositoryName is now a dynamic getter
    // producing `assignee-ecr-repository-<8hex>` on each access.
    expect(ecrRepositoryPlugin.defaults["ImageTagMutability"]).toBe(
      "IMMUTABLE",
    );
    expect(ecrRepositoryPlugin.defaults["ImageScanningConfiguration"]).toEqual({
      ScanOnPush: true,
    });
    const defaultName = ecrRepositoryPlugin.defaults["RepositoryName"];
    expect(typeof defaultName).toBe("string");
    expect(defaultName as string).toMatch(
      /^assignee-ecr-repository-[0-9a-f]{8}$/,
    );
  });

  it("configHints guides LLM to OMIT RepositoryName for auto-generation (C-22)", () => {
    const hints = ecrRepositoryPlugin.configHints!.join(" ");
    expect(hints).toMatch(/RepositoryName/);
    expect(hints).toMatch(/OMIT|auto-generate/i);
    expect(hints).toMatch(/assignee-ecr-repository/);
  });
});

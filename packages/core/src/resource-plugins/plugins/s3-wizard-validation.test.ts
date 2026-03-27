import { describe, it, expect } from "vitest";
import { s3BucketPlugin } from "./s3-bucket.js";
import { defaultPluginRegistry } from "../index.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const allFields = [
  ...s3BucketPlugin.commonFields,
  ...s3BucketPlugin.advancedFields,
];
const findField = (name: string) => allFields.find((f) => f.name === name)!;
const tagsField = findField("Tags");
const tagsValidate = tagsField.question.validate!;
const tagsToCfn = tagsField.toCfn!;

/**
 * Mirrors plan-generator.ts applyToCfnTransforms + assembleS3Composites
 * to test composite assembly without cross-package imports.
 */
function applyToCfnTransforms(
  elicitedOptions: Record<string, unknown>,
): Record<string, unknown> {
  const plugin = defaultPluginRegistry.get("AWS::S3::Bucket");
  if (!plugin) return elicitedOptions;

  const fields = [...plugin.commonFields, ...plugin.advancedFields];
  const transformed: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(elicitedOptions)) {
    const field = fields.find((f) => f.name === key);
    if (field?.toCfn) {
      const cfnValue = field.toCfn(value);
      if (cfnValue !== undefined) {
        transformed[key] = cfnValue;
      }
    } else if (value !== false) {
      transformed[key] = value;
    }
  }

  // Replicate assembleS3Composites from plan-generator.ts
  assembleS3Composites(transformed, elicitedOptions);
  return transformed;
}

function assembleS3Composites(
  transformed: Record<string, unknown>,
  options: Record<string, unknown>,
): void {
  // Encryption
  if (options["BucketEncryption"] === true) {
    const kmsKey = options["KMSMasterKeyID"];
    const algorithm = kmsKey && String(kmsKey).trim() ? "aws:kms" : "AES256";
    transformed["BucketEncryption"] = {
      ServerSideEncryptionConfiguration: [
        {
          ServerSideEncryptionByDefault: {
            SSEAlgorithm: algorithm,
            ...(algorithm === "aws:kms"
              ? { KMSMasterKeyID: String(kmsKey) }
              : {}),
          },
        },
      ],
    };
  } else {
    delete transformed["BucketEncryption"];
  }
  delete transformed["KMSMasterKeyID"];

  // Lifecycle
  if (options["EnableLifecycle"] === true) {
    const transitionDays =
      parseInt(String(options["LifecycleTransitionDays"] ?? "30"), 10) || 30;
    const expirationDaysRaw = options["LifecycleExpirationDays"];
    const expirationDays =
      expirationDaysRaw && String(expirationDaysRaw).trim()
        ? parseInt(String(expirationDaysRaw), 10)
        : undefined;
    const rule: Record<string, unknown> = {
      Status: "Enabled",
      Transitions: [
        { StorageClass: "STANDARD_IA", TransitionInDays: transitionDays },
      ],
    };
    if (expirationDays && expirationDays > 0) {
      rule["ExpirationInDays"] = expirationDays;
    }
    transformed["LifecycleConfiguration"] = { Rules: [rule] };
  }
  delete transformed["EnableLifecycle"];
  delete transformed["LifecycleTransitionDays"];
  delete transformed["LifecycleExpirationDays"];

  // CORS
  if (options["EnableCors"] === true) {
    const origins = String(options["CorsAllowedOrigins"] ?? "*")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const methods = String(options["CorsAllowedMethods"] ?? "GET")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    transformed["CorsConfiguration"] = {
      CorsRules: [{ AllowedMethods: methods, AllowedOrigins: origins }],
    };
  }
  delete transformed["EnableCors"];
  delete transformed["CorsAllowedOrigins"];
  delete transformed["CorsAllowedMethods"];
}

/**
 * Mirrors fix-applicator.ts isFieldExplicitlySet to test the
 * wizardKeyMap contract without cross-package imports.
 */
function isFieldExplicitlySet(
  elicitedOptions: Record<string, unknown> | undefined,
  patch: Record<string, unknown>,
): boolean {
  if (!elicitedOptions) return false;

  for (const key of Object.keys(patch)) {
    if (key in elicitedOptions) return true;

    const wizardKeyMap: Record<string, string[]> = {
      BlockDeviceMappings: ["EbsEncrypted", "EbsVolumeType", "EbsVolumeSize"],
      MetadataOptions: ["HttpTokens"],
      PublicAccessBlockConfiguration: [
        "BlockPublicAcls",
        "BlockPublicPolicy",
        "IgnorePublicAcls",
        "RestrictPublicBuckets",
      ],
      PubliclyAccessible: ["PubliclyAccessible"],
      StorageEncrypted: ["StorageEncrypted"],
      MultiAZ: ["MultiAZ"],
      DeletionProtection: ["DeletionProtection"],
      VersioningConfiguration: ["VersioningConfiguration"],
      BucketEncryption: ["BucketEncryption", "KMSMasterKeyID"],
      LifecycleConfiguration: [
        "EnableLifecycle",
        "LifecycleTransitionDays",
        "LifecycleExpirationDays",
      ],
    };

    const wizardKeys = wizardKeyMap[key];
    if (wizardKeys === undefined) {
      return true;
    }
    if (wizardKeys.some((wk) => wk in elicitedOptions)) {
      return true;
    }
  }

  return false;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════════

// ── Tags validation ──────────────────────────────────────────────────────────

describe("Tags field — validate", () => {
  it("accepts valid tags: 'env:production, team:backend'", () => {
    expect(tagsValidate("env:production, team:backend")).toBeUndefined();
  });

  it("rejects tags without colons: 'vvbbcc' → error message", () => {
    const result = tagsValidate("vvbbcc");
    expect(result).toBeDefined();
    expect(result).toContain("Invalid tag format");
  });

  it("warns about mixed valid/invalid: 'env:prod, badtag, team:be'", () => {
    const result = tagsValidate("env:prod, badtag, team:be");
    expect(result).toBeDefined();
    expect(result).toContain("badtag");
    expect(result).toContain("missing a colon");
  });

  it("accepts empty string (optional field)", () => {
    expect(tagsValidate("")).toBeUndefined();
  });

  it("accepts undefined/falsy value (optional field)", () => {
    expect(tagsValidate(undefined)).toBeUndefined();
    expect(tagsValidate(null)).toBeUndefined();
  });

  it("accepts tags with colons in value: 'resource:arn:aws:s3:::bucket'", () => {
    expect(tagsValidate("resource:arn:aws:s3:::bucket")).toBeUndefined();
  });
});

// ── Tags toCfn ───────────────────────────────────────────────────────────────

describe("Tags field — toCfn", () => {
  it("transforms valid tags into CFN Tag array", () => {
    const result = tagsToCfn("env:production, team:backend");
    expect(result).toEqual([
      { Key: "env", Value: "production" },
      { Key: "team", Value: "backend" },
    ]);
  });

  it("returns undefined for 'vvbbcc' (no colons) — not empty array", () => {
    const result = tagsToCfn("vvbbcc");
    expect(result).toBeUndefined();
    // Regression guard: must NOT return []
    expect(result).not.toEqual([]);
  });

  it("filters out invalid tags in mixed input, keeps valid ones", () => {
    const result = tagsToCfn("env:prod, badtag, team:be");
    expect(result).toEqual([
      { Key: "env", Value: "prod" },
      { Key: "team", Value: "be" },
    ]);
  });

  it("returns undefined for empty string", () => {
    expect(tagsToCfn("")).toBeUndefined();
  });

  it("returns undefined for non-string input", () => {
    expect(tagsToCfn(undefined)).toBeUndefined();
    expect(tagsToCfn(null)).toBeUndefined();
    expect(tagsToCfn(42)).toBeUndefined();
  });

  it("correctly handles colons in value via rest.join(':')", () => {
    const result = tagsToCfn("arn:aws:s3:::bucket");
    expect(result).toEqual([{ Key: "arn", Value: "aws:s3:::bucket" }]);
  });

  it("trims whitespace in keys and values", () => {
    const result = tagsToCfn(" env : prod , team : be ");
    expect(result).toEqual([
      { Key: "env", Value: "prod" },
      { Key: "team", Value: "be" },
    ]);
  });
});

// ── S3 composite assembly ────────────────────────────────────────────────────

describe("S3 composite assembly (applyToCfnTransforms)", () => {
  it("BucketEncryption=true without KMS → SSE-S3 (AES256)", () => {
    const result = applyToCfnTransforms({ BucketEncryption: true });
    expect(result["BucketEncryption"]).toEqual({
      ServerSideEncryptionConfiguration: [
        {
          ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" },
        },
      ],
    });
  });

  it("BucketEncryption=true with KMS key → SSE-KMS config", () => {
    const kmsArn = "arn:aws:kms:us-east-1:123456789012:key/abcd-1234";
    const result = applyToCfnTransforms({
      BucketEncryption: true,
      KMSMasterKeyID: kmsArn,
    });
    expect(result["BucketEncryption"]).toEqual({
      ServerSideEncryptionConfiguration: [
        {
          ServerSideEncryptionByDefault: {
            SSEAlgorithm: "aws:kms",
            KMSMasterKeyID: kmsArn,
          },
        },
      ],
    });
    // KMSMasterKeyID intermediate key must be removed
    expect(result["KMSMasterKeyID"]).toBeUndefined();
  });

  it("EnableLifecycle=true → LifecycleConfiguration", () => {
    const result = applyToCfnTransforms({
      EnableLifecycle: true,
      LifecycleTransitionDays: "60",
      LifecycleExpirationDays: "365",
    });
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
    // Intermediate keys removed
    expect(result["EnableLifecycle"]).toBeUndefined();
    expect(result["LifecycleTransitionDays"]).toBeUndefined();
    expect(result["LifecycleExpirationDays"]).toBeUndefined();
  });

  it("EnableCors=true → CorsConfiguration", () => {
    const result = applyToCfnTransforms({
      EnableCors: true,
      CorsAllowedOrigins: "https://example.com, https://app.example.com",
      CorsAllowedMethods: "GET,PUT",
    });
    expect(result["CorsConfiguration"]).toEqual({
      CorsRules: [
        {
          AllowedMethods: ["GET", "PUT"],
          AllowedOrigins: ["https://example.com", "https://app.example.com"],
        },
      ],
    });
    expect(result["EnableCors"]).toBeUndefined();
    expect(result["CorsAllowedOrigins"]).toBeUndefined();
    expect(result["CorsAllowedMethods"]).toBeUndefined();
  });

  it("BucketEncryption=false → no BucketEncryption in output", () => {
    const result = applyToCfnTransforms({ BucketEncryption: false });
    expect(result["BucketEncryption"]).toBeUndefined();
  });
});

// ── BP auto-fix: isFieldExplicitlySet wizardKeyMap contract ──────────────────

describe("isFieldExplicitlySet — wizardKeyMap contract", () => {
  describe("VersioningConfiguration", () => {
    it("returns true when elicitedOptions has VersioningConfiguration", () => {
      expect(
        isFieldExplicitlySet(
          { VersioningConfiguration: true },
          { VersioningConfiguration: { Status: "Enabled" } },
        ),
      ).toBe(true);
    });

    it("returns false when elicitedOptions lacks VersioningConfiguration", () => {
      expect(
        isFieldExplicitlySet(
          { BucketName: "my-bucket" },
          { VersioningConfiguration: { Status: "Enabled" } },
        ),
      ).toBe(false);
    });
  });

  describe("BucketEncryption", () => {
    it("returns true when elicitedOptions has BucketEncryption", () => {
      expect(
        isFieldExplicitlySet(
          { BucketEncryption: true },
          { BucketEncryption: {} },
        ),
      ).toBe(true);
    });

    it("returns true when elicitedOptions has KMSMasterKeyID", () => {
      expect(
        isFieldExplicitlySet(
          { KMSMasterKeyID: "arn:aws:kms:us-east-1:123:key/abc" },
          { BucketEncryption: {} },
        ),
      ).toBe(true);
    });

    it("returns false when neither BucketEncryption nor KMSMasterKeyID set", () => {
      expect(
        isFieldExplicitlySet(
          { BucketName: "my-bucket" },
          { BucketEncryption: {} },
        ),
      ).toBe(false);
    });
  });

  describe("LifecycleConfiguration", () => {
    it("returns true when elicitedOptions has EnableLifecycle", () => {
      expect(
        isFieldExplicitlySet(
          { EnableLifecycle: true },
          { LifecycleConfiguration: { Rules: [] } },
        ),
      ).toBe(true);
    });

    it("returns true when elicitedOptions has LifecycleTransitionDays", () => {
      expect(
        isFieldExplicitlySet(
          { LifecycleTransitionDays: "30" },
          { LifecycleConfiguration: { Rules: [] } },
        ),
      ).toBe(true);
    });

    it("returns true when elicitedOptions has LifecycleExpirationDays", () => {
      expect(
        isFieldExplicitlySet(
          { LifecycleExpirationDays: "365" },
          { LifecycleConfiguration: { Rules: [] } },
        ),
      ).toBe(true);
    });

    it("returns false when no lifecycle wizard keys are set", () => {
      expect(
        isFieldExplicitlySet(
          { BucketName: "my-bucket" },
          { LifecycleConfiguration: { Rules: [] } },
        ),
      ).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("returns false when elicitedOptions is undefined", () => {
      expect(
        isFieldExplicitlySet(undefined, {
          VersioningConfiguration: { Status: "Enabled" },
        }),
      ).toBe(false);
    });

    it("returns true for unknown patch keys (safe default)", () => {
      expect(
        isFieldExplicitlySet(
          { BucketName: "my-bucket" },
          { SomeUnknownProperty: "value" },
        ),
      ).toBe(true);
    });
  });
});

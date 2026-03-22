import { describe, it, expect } from "vitest";
import { ZodError } from "zod";
import { bestPracticeSchema } from "../src/schema.js";

const validBP = {
  id: "BP-S3-001",
  title: "S3 Public Access Block not enabled",
  severity: "CRITICAL",
  resource_type: "AWS::S3::Bucket",
  property_path: "PublicAccessBlockConfiguration.BlockPublicAcls",
  check_type: "equals",
  expected_value: true,
  source: "AWS Security Hub FSBP",
  source_id: "S3.1",
  description:
    "S3 buckets should have public access blocked to prevent data exposure",
  remediation:
    "Enable all four PublicAccessBlockConfiguration settings: BlockPublicAcls, BlockPublicPolicy, IgnorePublicAcls, RestrictPublicBuckets",
  category: "security",
  lastVerified: "2026-03-22",
} as const;

describe("bestPracticeSchema", () => {
  it("validates a complete valid BP object", () => {
    const result = bestPracticeSchema.parse(validBP);
    expect(result.id).toBe("BP-S3-001");
    expect(result.severity).toBe("CRITICAL");
  });

  it("validates a valid BP with only required fields", () => {
    const minimal = {
      id: "BP-EC2-001",
      title: "EC2 test rule",
      severity: "HIGH",
      resource_type: "AWS::EC2::Instance",
      property_path: "Monitoring.Enabled",
      check_type: "equals",
      expected_value: true,
      source: "CIS Benchmark",
      category: "reliability",
      lastVerified: "2026-01-15",
    };
    const result = bestPracticeSchema.parse(minimal);
    expect(result.id).toBe("BP-EC2-001");
    expect(result.source_id).toBeUndefined();
    expect(result.description).toBeUndefined();
  });

  it("validates a BP with triggers", () => {
    const withTriggers = {
      ...validBP,
      triggers: [
        { resourceType: "AWS::S3::Bucket", always: true },
        { intentKeywords: ["s3", "bucket", "storage"] },
        {
          fieldCondition: "PublicAccessBlockConfiguration",
          patternId: "public-s3",
        },
      ],
    };
    const result = bestPracticeSchema.parse(withTriggers);
    expect(result.triggers).toHaveLength(3);
  });

  it("rejects missing required field (id)", () => {
    const { id: _id, ...noId } = validBP;
    expect(() => bestPracticeSchema.parse(noId)).toThrow(ZodError);
    try {
      bestPracticeSchema.parse(noId);
    } catch (err) {
      expect(err).toBeInstanceOf(ZodError);
      const zodErr = err as ZodError;
      const idError = zodErr.errors.find((e) => e.path.includes("id"));
      expect(idError).toBeDefined();
    }
  });

  it('rejects invalid severity value "LOW"', () => {
    const badSeverity = { ...validBP, severity: "LOW" };
    expect(() => bestPracticeSchema.parse(badSeverity)).toThrow(ZodError);
    try {
      bestPracticeSchema.parse(badSeverity);
    } catch (err) {
      const zodErr = err as ZodError;
      const sevError = zodErr.errors.find((e) => e.path.includes("severity"));
      expect(sevError).toBeDefined();
      expect(sevError?.message).toContain("Invalid enum value");
    }
  });

  it("rejects invalid id format (missing BP- prefix)", () => {
    const badId = { ...validBP, id: "S3-001" };
    expect(() => bestPracticeSchema.parse(badId)).toThrow(ZodError);
    try {
      bestPracticeSchema.parse(badId);
    } catch (err) {
      const zodErr = err as ZodError;
      const idError = zodErr.errors.find((e) => e.path.includes("id"));
      expect(idError).toBeDefined();
      expect(idError?.message).toContain("BP ID must match format");
    }
  });

  it("rejects extra unknown field in strict mode", () => {
    const withExtra = { ...validBP, unknownField: "should fail" };
    expect(() => bestPracticeSchema.parse(withExtra)).toThrow(ZodError);
    try {
      bestPracticeSchema.parse(withExtra);
    } catch (err) {
      const zodErr = err as ZodError;
      const extraError = zodErr.errors.find((e) =>
        e.message.includes("Unrecognized key"),
      );
      expect(extraError).toBeDefined();
    }
  });

  it("rejects missing lastVerified", () => {
    const { lastVerified: _lv, ...noLastVerified } = validBP;
    expect(() => bestPracticeSchema.parse(noLastVerified)).toThrow(ZodError);
  });

  it("rejects invalid lastVerified format", () => {
    const badDate = { ...validBP, lastVerified: "03-22-2026" };
    expect(() => bestPracticeSchema.parse(badDate)).toThrow(ZodError);
  });

  it("validates blocking: true", () => {
    const withBlocking = { ...validBP, blocking: true };
    const result = bestPracticeSchema.parse(withBlocking);
    expect(result.blocking).toBe(true);
  });

  it("defaults blocking to false when not specified", () => {
    const result = bestPracticeSchema.parse(validBP);
    expect(result.blocking).toBe(false);
  });

  it("rejects non-boolean blocking value", () => {
    const badBlocking = { ...validBP, blocking: "yes" };
    expect(() => bestPracticeSchema.parse(badBlocking)).toThrow(ZodError);
  });
});

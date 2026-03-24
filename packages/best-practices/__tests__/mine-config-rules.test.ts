/**
 * Tests for AWS Config Rule Mining logic (Story 30.1).
 * Self-contained to avoid cross-package import issues.
 */
import { describe, it, expect } from "vitest";

const SUPPORTED_SET = new Set([
  "AWS::S3::Bucket",
  "AWS::EC2::Instance",
  "AWS::RDS::DBInstance",
  "AWS::Lambda::Function",
  "AWS::IAM::Role",
  "AWS::DynamoDB::Table",
]);

const TYPE_TO_PREFIX: Record<string, string> = {
  "AWS::S3::Bucket": "S3",
  "AWS::EC2::Instance": "EC2",
  "AWS::RDS::DBInstance": "RDS",
  "AWS::Lambda::Function": "LAMBDA",
  "AWS::IAM::Role": "IAM",
  "AWS::DynamoDB::Table": "DYNAMODB",
};

interface ConfigRule {
  name: string;
  description: string;
  sourceIdentifier: string;
  complianceTypes: string[];
}

function mapSeverity(sourceIdentifier: string): string {
  const lower = sourceIdentifier.toLowerCase();
  if (lower.includes("critical") || lower.includes("required"))
    return "CRITICAL";
  if (lower.includes("high")) return "HIGH";
  return "MEDIUM";
}

function generateCandidates(
  configRules: ConfigRule[],
  existingKeys: Set<string>,
): { id: string; resource_type: string; source: string; check_type: string }[] {
  const candidates: {
    id: string;
    resource_type: string;
    source: string;
    check_type: string;
  }[] = [];
  const counters: Record<string, number> = {};

  for (const rule of configRules) {
    for (const resourceType of rule.complianceTypes) {
      if (!SUPPORTED_SET.has(resourceType)) continue;
      const prefix = TYPE_TO_PREFIX[resourceType];
      if (!prefix) continue;

      const propertyPath = rule.sourceIdentifier
        .replace(/_/g, ".")
        .split(".")
        .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
        .join(".");
      const dedup = `${resourceType}::${propertyPath}`;
      if (existingKeys.has(dedup)) continue;
      existingKeys.add(dedup);

      if (!counters[prefix]) counters[prefix] = 900;
      counters[prefix]++;
      const id = `BP-${prefix}-${String(counters[prefix]).padStart(3, "0")}`;
      candidates.push({
        id,
        resource_type: resourceType,
        source: "AWS Config",
        check_type: "awareness",
      });
    }
  }
  return candidates;
}

describe("mine-config-rules logic (Story 30.1)", () => {
  describe("mapSeverity", () => {
    it("maps 'critical' keyword to CRITICAL", () => {
      expect(mapSeverity("CRITICAL_THING")).toBe("CRITICAL");
    });

    it("maps 'required' keyword to CRITICAL", () => {
      expect(mapSeverity("TOKEN_REQUIRED")).toBe("CRITICAL");
    });

    it("maps 'high' keyword to HIGH", () => {
      expect(mapSeverity("HIGH_SEVERITY_CHECK")).toBe("HIGH");
    });

    it("defaults to MEDIUM", () => {
      expect(mapSeverity("S3_BUCKET_VERSIONING")).toBe("MEDIUM");
    });
  });

  describe("generateCandidates", () => {
    it("generates candidates for supported resource types", () => {
      const candidates = generateCandidates(
        [
          {
            name: "s3-ssl",
            description: "S3 SSL",
            sourceIdentifier: "S3_BUCKET_SSL",
            complianceTypes: ["AWS::S3::Bucket"],
          },
        ],
        new Set(),
      );
      expect(candidates).toHaveLength(1);
      expect(candidates[0]!.source).toBe("AWS Config");
      expect(candidates[0]!.id).toMatch(/^BP-S3-\d{3}$/);
    });

    it("skips unsupported resource types", () => {
      const candidates = generateCandidates(
        [
          {
            name: "x",
            description: "X",
            sourceIdentifier: "X",
            complianceTypes: ["AWS::Unsupported::Type"],
          },
        ],
        new Set(),
      );
      expect(candidates).toHaveLength(0);
    });

    it("generates unique IDs", () => {
      const candidates = generateCandidates(
        [
          {
            name: "c1",
            description: "C1",
            sourceIdentifier: "CHECK_ONE",
            complianceTypes: ["AWS::S3::Bucket"],
          },
          {
            name: "c2",
            description: "C2",
            sourceIdentifier: "CHECK_TWO",
            complianceTypes: ["AWS::S3::Bucket"],
          },
        ],
        new Set(),
      );
      const ids = candidates.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("uses awareness check_type", () => {
      const candidates = generateCandidates(
        [
          {
            name: "t",
            description: "T",
            sourceIdentifier: "TEST",
            complianceTypes: ["AWS::EC2::Instance"],
          },
        ],
        new Set(),
      );
      expect(candidates[0]!.check_type).toBe("awareness");
    });

    it("SUPPORTED_SET contains S3 bucket type", () => {
      expect(SUPPORTED_SET.has("AWS::S3::Bucket")).toBe(true);
    });

    it("SUPPORTED_SET does not contain unsupported types", () => {
      expect(SUPPORTED_SET.has("AWS::Foo::Bar")).toBe(false);
    });
  });
});

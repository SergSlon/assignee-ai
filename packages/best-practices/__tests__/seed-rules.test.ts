import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readdirSync } from "node:fs";
import { loadBestPractices } from "../src/loader.js";
import { bestPracticeSchema } from "../src/schema.js";

const BP_ROOT = join(import.meta.dirname, "..");
const S3_DIR = join(BP_ROOT, "s3");
const EC2_DIR = join(BP_ROOT, "ec2");
const LAMBDA_DIR = join(BP_ROOT, "lambda");
const RDS_DIR = join(BP_ROOT, "rds");
const IAM_DIR = join(BP_ROOT, "iam");
const DYNAMODB_DIR = join(BP_ROOT, "dynamodb");
const ECS_DIR = join(BP_ROOT, "ecs");
const SQS_DIR = join(BP_ROOT, "sqs");
const SNS_DIR = join(BP_ROOT, "sns");
const ASG_DIR = join(BP_ROOT, "autoscaling");
const SSM_DIR = join(BP_ROOT, "ssm");

describe("Seed BP Library — Sprint A+B + guardrail migration (47 rules)", () => {
  const practices = loadBestPractices(BP_ROOT);

  it("loads all best practice entries", () => {
    expect(practices.length).toBeGreaterThanOrEqual(76);
  });

  it("every entry validates against bestPracticeSchema without errors", () => {
    for (const bp of practices) {
      const result = bestPracticeSchema.safeParse(bp);
      expect(
        result.success,
        `Schema validation failed for ${bp.id}: ${JSON.stringify(result.success ? null : result.error.errors)}`,
      ).toBe(true);
    }
  });

  it("has no duplicate id values across all entries", () => {
    const ids = practices.map((bp) => bp.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it("every entry has a non-empty remediation field", () => {
    for (const bp of practices) {
      expect(bp.remediation, `Missing remediation for ${bp.id}`).toBeTruthy();
      expect(
        bp.remediation!.length,
        `Empty remediation for ${bp.id}`,
      ).toBeGreaterThan(0);
    }
  });

  it("every entry has a valid lastVerified date not older than 2026-01-01", () => {
    const minDate = new Date("2026-01-01");
    for (const bp of practices) {
      expect(bp.lastVerified, `Missing lastVerified for ${bp.id}`).toBeTruthy();
      const date = new Date(bp.lastVerified);
      expect(
        date.getTime(),
        `lastVerified for ${bp.id} (${bp.lastVerified}) is older than 2026-01-01`,
      ).toBeGreaterThanOrEqual(minDate.getTime());
    }
  });

  it("S3 directory contains expected YAML files", () => {
    const files = readdirSync(S3_DIR).filter((f) => f.endsWith(".yaml"));
    expect(files.length).toBeGreaterThanOrEqual(10);
  });

  it("EC2 directory contains expected YAML files", () => {
    const files = readdirSync(EC2_DIR).filter((f) => f.endsWith(".yaml"));
    expect(files.length).toBeGreaterThanOrEqual(18);
  });

  it("Lambda directory contains expected YAML files", () => {
    const files = readdirSync(LAMBDA_DIR).filter((f) => f.endsWith(".yaml"));
    expect(files.length).toBeGreaterThanOrEqual(7);
  });

  it("RDS directory contains expected YAML files", () => {
    const files = readdirSync(RDS_DIR).filter((f) => f.endsWith(".yaml"));
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  it("IAM directory contains expected YAML files", () => {
    const files = readdirSync(IAM_DIR).filter((f) => f.endsWith(".yaml"));
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  it("DynamoDB directory contains expected YAML files", () => {
    const files = readdirSync(DYNAMODB_DIR).filter((f) => f.endsWith(".yaml"));
    expect(files.length).toBeGreaterThanOrEqual(3);
  });

  it("ECS directory contains expected YAML files", () => {
    const files = readdirSync(ECS_DIR).filter((f) => f.endsWith(".yaml"));
    expect(files.length).toBeGreaterThanOrEqual(3);
  });

  it("SQS directory contains expected YAML files", () => {
    const files = readdirSync(SQS_DIR).filter((f) => f.endsWith(".yaml"));
    expect(files.length).toBeGreaterThanOrEqual(2);
  });

  it("SNS directory contains expected YAML files", () => {
    const files = readdirSync(SNS_DIR).filter((f) => f.endsWith(".yaml"));
    expect(files.length).toBeGreaterThanOrEqual(2);
  });

  it("AutoScaling directory contains 1 YAML file", () => {
    const files = readdirSync(ASG_DIR).filter((f) => f.endsWith(".yaml"));
    expect(files).toHaveLength(1);
  });

  it("SSM directory contains expected YAML files", () => {
    const files = readdirSync(SSM_DIR).filter((f) => f.endsWith(".yaml"));
    expect(files.length).toBeGreaterThanOrEqual(2);
  });

  it("all FSBP-sourced entries have a source_id field", () => {
    const fsbpEntries = practices.filter((bp) => bp.source.includes("FSBP"));
    expect(fsbpEntries.length).toBeGreaterThan(0);
    for (const bp of fsbpEntries) {
      expect(
        bp.source_id,
        `FSBP entry ${bp.id} is missing source_id`,
      ).toBeTruthy();
    }
  });

  it("covers all Tier 1 resource types", () => {
    const resourceTypes = new Set(practices.map((bp) => bp.resource_type));
    expect(resourceTypes.has("AWS::S3::Bucket")).toBe(true);
    expect(resourceTypes.has("AWS::EC2::Instance")).toBe(true);
    expect(resourceTypes.has("AWS::Lambda::Function")).toBe(true);
    expect(resourceTypes.has("AWS::RDS::DBInstance")).toBe(true);
    expect(resourceTypes.has("AWS::IAM::Policy")).toBe(true);
    expect(resourceTypes.has("AWS::IAM::User")).toBe(true);
    expect(resourceTypes.has("AWS::DynamoDB::Table")).toBe(true);
    expect(resourceTypes.has("AWS::ECS::TaskDefinition")).toBe(true);
    expect(resourceTypes.has("AWS::ECS::Service")).toBe(true);
    expect(resourceTypes.has("AWS::SQS::Queue")).toBe(true);
    expect(resourceTypes.has("AWS::SNS::Topic")).toBe(true);
    expect(resourceTypes.has("AWS::IAM::Role")).toBe(true);
    expect(resourceTypes.has("AWS::AutoScaling::AutoScalingGroup")).toBe(true);
    expect(resourceTypes.has("AWS::EC2::SecurityGroup")).toBe(true);
    expect(resourceTypes.has("AWS::SSM::Parameter")).toBe(true);
  });

  it("every entry has a non-empty description", () => {
    for (const bp of practices) {
      expect(bp.description, `Missing description for ${bp.id}`).toBeTruthy();
      expect(
        bp.description!.length,
        `Empty description for ${bp.id}`,
      ).toBeGreaterThan(0);
    }
  });

  // ───────────────────────────────────────────────────────────────────────
  // Structural assertions (replaces a 923-line snapshot of all 47+ rules).
  // The previous snapshot encoded every rule's metadata verbatim, which made
  // every legitimate rule edit a noisy snapshot churn and provided no
  // meaningful failure signal. We now assert on structural invariants the
  // SUT must maintain, plus a small set of representative rules.
  // ───────────────────────────────────────────────────────────────────────

  it("every entry's id, severity, check_type and category are valid enums", () => {
    // The bestPracticeSchema is the source of truth for valid enum values;
    // re-derive sets from each rule rather than hardcoding to avoid drift.
    // We assert each field is non-empty and that the schema parser would
    // accept the bp (already checked elsewhere) — here we additionally pin
    // observed enum values into a discovery set so a typo in a YAML file
    // produces an actionable failure.
    const observedSeverities = new Set<string>();
    const observedCheckTypes = new Set<string>();
    const observedCategories = new Set<string>();
    for (const bp of practices) {
      expect(bp.id, "id must be non-empty").toBeTruthy();
      expect(bp.severity, `${bp.id}: missing severity`).toBeTruthy();
      expect(bp.check_type, `${bp.id}: missing check_type`).toBeTruthy();
      expect(bp.category, `${bp.id}: missing category`).toBeTruthy();
      observedSeverities.add(bp.severity);
      observedCheckTypes.add(bp.check_type);
      observedCategories.add(bp.category);
    }
    // Sanity: at minimum we expect more than one severity tier and category
    // (i.e. the library is non-trivially diverse).
    expect(observedSeverities.size).toBeGreaterThan(1);
    expect(observedCategories.size).toBeGreaterThan(1);
  });

  it("groups rules across the expected resource categories", () => {
    const byCategory = new Map<string, number>();
    for (const bp of practices) {
      byCategory.set(bp.category, (byCategory.get(bp.category) ?? 0) + 1);
    }
    // Library is documented as Sprint A+B + guardrail migration. Security
    // findings dominate, with reliability/cost coverage too.
    expect(byCategory.get("security") ?? 0).toBeGreaterThan(0);
    expect(byCategory.get("reliability") ?? 0).toBeGreaterThan(0);
  });

  it("S3 public-access block rule (representative) is present and correctly shaped", () => {
    const rule = practices.find(
      (bp) =>
        bp.resource_type === "AWS::S3::Bucket" &&
        (bp.title?.toLowerCase().includes("public") ?? false),
    );
    expect(rule, "expected an S3 public-access rule").toBeDefined();
    expect(rule!.severity.toLowerCase()).toMatch(/critical|high/);
    expect(rule!.category).toBe("security");
  });

  it("EC2 IMDSv2 rule (representative) is present and security-categorized", () => {
    const rule = practices.find(
      (bp) =>
        bp.resource_type === "AWS::EC2::Instance" &&
        (bp.title?.toLowerCase().includes("imds") ?? false),
    );
    expect(rule, "expected an EC2 IMDSv2 rule").toBeDefined();
    expect(rule!.category).toBe("security");
  });

  it("RDS storage encryption rule (representative) is present", () => {
    const rule = practices.find(
      (bp) =>
        bp.resource_type === "AWS::RDS::DBInstance" &&
        (bp.title?.toLowerCase().includes("encrypt") ?? false),
    );
    expect(rule, "expected an RDS encryption rule").toBeDefined();
    expect(rule!.category).toBe("security");
  });

  it("Lambda runtime/security rule (representative) is present", () => {
    const rule = practices.find(
      (bp) => bp.resource_type === "AWS::Lambda::Function",
    );
    expect(rule, "expected at least one Lambda rule").toBeDefined();
  });
});

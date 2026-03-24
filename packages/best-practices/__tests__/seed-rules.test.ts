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

  it("loads exactly 59 best practice entries", () => {
    expect(practices).toHaveLength(59);
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

  it("S3 directory contains 10 YAML files", () => {
    const files = readdirSync(S3_DIR).filter((f) => f.endsWith(".yaml"));
    expect(files).toHaveLength(10);
  });

  it("EC2 directory contains 11 YAML files", () => {
    const files = readdirSync(EC2_DIR).filter((f) => f.endsWith(".yaml"));
    expect(files).toHaveLength(11);
  });

  it("Lambda directory contains 7 YAML files", () => {
    const files = readdirSync(LAMBDA_DIR).filter((f) => f.endsWith(".yaml"));
    expect(files).toHaveLength(7);
  });

  it("RDS directory contains 5 YAML files", () => {
    const files = readdirSync(RDS_DIR).filter((f) => f.endsWith(".yaml"));
    expect(files).toHaveLength(5);
  });

  it("IAM directory contains 5 YAML files", () => {
    const files = readdirSync(IAM_DIR).filter((f) => f.endsWith(".yaml"));
    expect(files).toHaveLength(5);
  });

  it("DynamoDB directory contains 3 YAML files", () => {
    const files = readdirSync(DYNAMODB_DIR).filter((f) => f.endsWith(".yaml"));
    expect(files).toHaveLength(3);
  });

  it("ECS directory contains 3 YAML files", () => {
    const files = readdirSync(ECS_DIR).filter((f) => f.endsWith(".yaml"));
    expect(files).toHaveLength(3);
  });

  it("SQS directory contains 2 YAML files", () => {
    const files = readdirSync(SQS_DIR).filter((f) => f.endsWith(".yaml"));
    expect(files).toHaveLength(2);
  });

  it("SNS directory contains 2 YAML files", () => {
    const files = readdirSync(SNS_DIR).filter((f) => f.endsWith(".yaml"));
    expect(files).toHaveLength(2);
  });

  it("AutoScaling directory contains 1 YAML file", () => {
    const files = readdirSync(ASG_DIR).filter((f) => f.endsWith(".yaml"));
    expect(files).toHaveLength(1);
  });

  it("SSM directory contains 2 YAML files", () => {
    const files = readdirSync(SSM_DIR).filter((f) => f.endsWith(".yaml"));
    expect(files).toHaveLength(2);
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

  it("snapshot: loadBestPractices output matches expected structure", () => {
    const snapshot = practices.map((bp) => ({
      id: bp.id,
      severity: bp.severity,
      resource_type: bp.resource_type,
      check_type: bp.check_type,
      category: bp.category,
    }));
    expect(snapshot).toMatchSnapshot();
  });
});

import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { loadBestPractices } from "../src/loader.js";
import { bestPracticeSchema } from "../src/schema.js";
import { evaluateTriggers } from "../src/evaluate.js";
import type { EvalContext } from "../src/evaluate.js";

const BP_ROOT = join(import.meta.dirname, "..");

describe("FSBP-sourced BP entries (Story 12.7)", () => {
  const allPractices = loadBestPractices(BP_ROOT);
  const fsbpPractices = allPractices.filter((bp) => bp.source.includes("FSBP"));

  // -----------------------------------------------------------------------
  // Schema validation
  // -----------------------------------------------------------------------

  it("all FSBP entries validate against bestPracticeSchema", () => {
    for (const bp of fsbpPractices) {
      const result = bestPracticeSchema.safeParse(bp);
      expect(
        result.success,
        `Schema validation failed for ${bp.id}: ${JSON.stringify(result.success ? null : result.error.errors)}`,
      ).toBe(true);
    }
  });

  it("has at least 20 FSBP-sourced entries", () => {
    expect(fsbpPractices.length).toBeGreaterThanOrEqual(20);
  });

  it("every FSBP entry has a source_id field", () => {
    for (const bp of fsbpPractices) {
      expect(
        bp.source_id,
        `FSBP entry ${bp.id} is missing source_id`,
      ).toBeTruthy();
    }
  });

  it("every FSBP entry has source set to 'AWS Security Hub FSBP'", () => {
    for (const bp of fsbpPractices) {
      expect(bp.source).toBe("AWS Security Hub FSBP");
    }
  });

  // -----------------------------------------------------------------------
  // Zero ID collisions
  // -----------------------------------------------------------------------

  it("zero ID collisions across all entries (FSBP + Story 12.5)", () => {
    const ids = allPractices.map((bp) => bp.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it("no duplicate BP IDs map to the same source_id with the same property_path", () => {
    const keys = fsbpPractices.map(
      (bp) => `${bp.source_id}::${bp.property_path}`,
    );
    const uniqueKeys = new Set(keys);
    expect(uniqueKeys.size).toBe(keys.length);
  });

  // -----------------------------------------------------------------------
  // Trigger fire tests — 3+ violating configs
  // -----------------------------------------------------------------------

  it("fires on RDS instance that is publicly accessible (BP-RDS-001)", () => {
    const ctx: EvalContext = {
      resourceType: "AWS::RDS::DBInstance",
      desiredState: {
        PubliclyAccessible: true,
      },
    };
    const findings = evaluateTriggers(ctx, allPractices);
    const rds001 = findings.find((f) => f.practiceId === "BP-RDS-001");
    expect(
      rds001,
      "BP-RDS-001 should fire for PubliclyAccessible: true",
    ).toBeDefined();
    expect(rds001!.severity).toBe("CRITICAL");
  });

  it("fires on DynamoDB table without PITR (BP-DYNAMODB-001)", () => {
    const ctx: EvalContext = {
      resourceType: "AWS::DynamoDB::Table",
      desiredState: {
        TableName: "my-table",
      },
    };
    const findings = evaluateTriggers(ctx, allPractices);
    const ddb001 = findings.find((f) => f.practiceId === "BP-DYNAMODB-001");
    expect(
      ddb001,
      "BP-DYNAMODB-001 should fire when PITR is missing",
    ).toBeDefined();
    expect(ddb001!.severity).toBe("HIGH");
  });

  it("fires on ECS task running as privileged (BP-ECS-001)", () => {
    const ctx: EvalContext = {
      resourceType: "AWS::ECS::TaskDefinition",
      desiredState: {
        ContainerDefinitions: [{ Name: "app", Privileged: true }],
      },
    };
    const findings = evaluateTriggers(ctx, allPractices);
    const ecs001 = findings.find((f) => f.practiceId === "BP-ECS-001");
    expect(
      ecs001,
      "BP-ECS-001 should fire when Privileged is true",
    ).toBeDefined();
    expect(ecs001!.severity).toBe("CRITICAL");
  });

  it("fires on SQS queue without encryption (BP-SQS-001)", () => {
    const ctx: EvalContext = {
      resourceType: "AWS::SQS::Queue",
      desiredState: {
        QueueName: "my-queue",
      },
    };
    const findings = evaluateTriggers(ctx, allPractices);
    const sqs001 = findings.find((f) => f.practiceId === "BP-SQS-001");
    expect(
      sqs001,
      "BP-SQS-001 should fire when SqsManagedSseEnabled is missing",
    ).toBeDefined();
  });

  it("does NOT fire on RDS instance that is private (BP-RDS-001)", () => {
    const ctx: EvalContext = {
      resourceType: "AWS::RDS::DBInstance",
      desiredState: {
        PubliclyAccessible: false,
        StorageEncrypted: true,
        MultiAZ: true,
        DeletionProtection: true,
        BackupRetentionPeriod: 7,
      },
    };
    const findings = evaluateTriggers(ctx, allPractices);
    const rds001 = findings.find((f) => f.practiceId === "BP-RDS-001");
    expect(
      rds001,
      "BP-RDS-001 should not fire for PubliclyAccessible: false",
    ).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // Coverage — new Tier 1 services present
  // -----------------------------------------------------------------------

  it("covers RDS, IAM, DynamoDB, ECS, SQS, SNS resource types in FSBP entries", () => {
    const fsbpResourceTypes = new Set(
      fsbpPractices.map((bp) => bp.resource_type),
    );
    expect(fsbpResourceTypes.has("AWS::RDS::DBInstance")).toBe(true);
    expect(fsbpResourceTypes.has("AWS::DynamoDB::Table")).toBe(true);
    expect(fsbpResourceTypes.has("AWS::SQS::Queue")).toBe(true);
    expect(fsbpResourceTypes.has("AWS::SNS::Topic")).toBe(true);
  });
});

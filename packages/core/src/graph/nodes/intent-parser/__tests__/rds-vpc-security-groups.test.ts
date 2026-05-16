/**
 * Regression tests for DF-E2 fix — RDS VPC security group elicitation.
 *
 * Dogfood finding (2026-05-11): `assignee plan "rds postgres"` (or similar)
 * emitted `VPCSecurityGroups: []` in the plan output. This resulted in:
 *   - A skeletal plan the apply would reject at CloudControl time.
 *   - No pre-apply hint to the user about what was missing.
 *
 * Fix: `extractRdsVpcSecurityGroups` in `rds-intent-extractor.ts` detects
 * the missing SG early and either:
 *   (a) Extracts explicit `sg-XXXX` IDs if present in the intent.
 *   (b) Pushes an `RDS_VPC_SECURITY_GROUPS_EMPTY` advisory with the
 *       `--set VPCSecurityGroups=<sg-id>` escape hatch.
 *
 * These tests FAIL against the pre-fix code (no extractor exists, advisory
 * never fires, VPCSecurityGroups stays empty) and PASS after the fix.
 *
 * Story 108-A-02 — Probe axes exercised:
 *   Axis E — RDS intent with no VPC/SG specified → advisory fires, not []
 *   Axis F — RDS intent with explicit SG provided → extractor preserves SG
 *   Axis G — RDS intent with multiple SGs provided → all SGs preserved
 *   Axis H — Non-RDS resource types are unaffected
 */

import { describe, it, expect } from "vitest";
import { RESOURCE_TYPES } from "@/index.js";
import type { Advisory } from "../../intent-parser/intent-types.js";
import { extractRdsVpcSecurityGroups } from "../extractors/rds-intent-extractor.js";
import { enumerateTypes } from "../../../../__tests__/variant-matrix/index.js";

// ---------------------------------------------------------------------------
// Axis E — RDS intent with no VPC/SG specified → advisory fires
// ---------------------------------------------------------------------------

describe("Axis E — RDS intent with no SG: advisory fires, VPCSecurityGroups never []", () => {
  it("Axis E-1: no SG in intent → RDS_VPC_SECURITY_GROUPS_EMPTY advisory is pushed", () => {
    const elicited: Record<string, unknown> = {};
    const advisories: Advisory[] = [];

    extractRdsVpcSecurityGroups(
      "Create an RDS Postgres database db.t3.micro",
      RESOURCE_TYPES.RDS_DB_INSTANCE,
      elicited,
      advisories,
    );

    // Advisory must be pushed
    const advisory = advisories.find(
      (a) => a.code === "RDS_VPC_SECURITY_GROUPS_EMPTY",
    );
    expect(advisory).toBeDefined();
    expect(advisory!.hint).toContain("--set VPCSecurityGroups=");
  });

  it("Axis E-2: advisory hint contains rds-with-vpc compound alternative", () => {
    const elicited: Record<string, unknown> = {};
    const advisories: Advisory[] = [];

    extractRdsVpcSecurityGroups(
      "Create RDS postgres for staging",
      RESOURCE_TYPES.RDS_DB_INSTANCE,
      elicited,
      advisories,
    );

    const advisory = advisories.find(
      (a) => a.code === "RDS_VPC_SECURITY_GROUPS_EMPTY",
    );
    expect(advisory!.hint).toContain("rds-with-vpc");
  });

  it("Axis E-3: VPCSecurityGroups is NOT set to [] in elicited (stays absent)", () => {
    const elicited: Record<string, unknown> = {};
    const advisories: Advisory[] = [];

    extractRdsVpcSecurityGroups(
      "Create an RDS MySQL instance",
      RESOURCE_TYPES.RDS_DB_INSTANCE,
      elicited,
      advisories,
    );

    // The extractor must not SET VPCSecurityGroups to [] — it must leave
    // the field absent. The advisory tells the user to supply one.
    // The skeletal-plan-detector will flag absent as empty and prevent
    // the plan from being applied.
    expect(elicited["VPCSecurityGroups"]).toBeUndefined();
  });

  it("Axis E-4: advisory message contains actionable wording", () => {
    const elicited: Record<string, unknown> = {};
    const advisories: Advisory[] = [];

    extractRdsVpcSecurityGroups(
      "Create a RDS DBInstance postgres",
      RESOURCE_TYPES.RDS_DB_INSTANCE,
      elicited,
      advisories,
    );

    const advisory = advisories.find(
      (a) => a.code === "RDS_VPC_SECURITY_GROUPS_EMPTY",
    );
    expect(advisory).toBeDefined();
    expect(advisory!.message).toContain("No VPC security groups");
    expect(advisory!.message).toContain("fail at apply time");
  });
});

// ---------------------------------------------------------------------------
// Axis F — RDS intent with explicit SG provided → extractor preserves it
// ---------------------------------------------------------------------------

describe("Axis F — RDS intent with explicit SG: extractor preserves user value", () => {
  it("Axis F-1: explicit sg-XXXX in intent is extracted into VPCSecurityGroups", () => {
    const elicited: Record<string, unknown> = {};
    const advisories: Advisory[] = [];

    extractRdsVpcSecurityGroups(
      "Create an RDS Postgres with security group sg-0a1b2c3d4e5f67890",
      RESOURCE_TYPES.RDS_DB_INSTANCE,
      elicited,
      advisories,
    );

    expect(elicited["VPCSecurityGroups"]).toEqual(["sg-0a1b2c3d4e5f67890"]);
    // No advisory when user provided SG
    expect(
      advisories.filter((a) => a.code === "RDS_VPC_SECURITY_GROUPS_EMPTY"),
    ).toHaveLength(0);
  });

  it("Axis F-2: legacy 8-char SG ID is extracted", () => {
    const elicited: Record<string, unknown> = {};
    const advisories: Advisory[] = [];

    extractRdsVpcSecurityGroups(
      "Create RDS postgres using sg-12345678",
      RESOURCE_TYPES.RDS_DB_INSTANCE,
      elicited,
      advisories,
    );

    expect(elicited["VPCSecurityGroups"]).toEqual(["sg-12345678"]);
    expect(
      advisories.filter((a) => a.code === "RDS_VPC_SECURITY_GROUPS_EMPTY"),
    ).toHaveLength(0);
  });

  it("Axis F-3: elicited SG value set before extraction is preserved without modification", () => {
    const elicited: Record<string, unknown> = {
      VPCSecurityGroups: ["sg-preset-from-config"],
    };
    const advisories: Advisory[] = [];

    extractRdsVpcSecurityGroups(
      "Create an RDS Postgres instance",
      RESOURCE_TYPES.RDS_DB_INSTANCE,
      elicited,
      advisories,
    );

    // Pre-set value must NOT be overwritten
    expect(elicited["VPCSecurityGroups"]).toEqual(["sg-preset-from-config"]);
    expect(
      advisories.filter((a) => a.code === "RDS_VPC_SECURITY_GROUPS_EMPTY"),
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Axis G — RDS intent with multiple SGs → all preserved
// ---------------------------------------------------------------------------

describe("Axis G — RDS intent with multiple SGs: all are extracted", () => {
  it("Axis G-1: two SG IDs in intent → both extracted", () => {
    const elicited: Record<string, unknown> = {};
    const advisories: Advisory[] = [];

    extractRdsVpcSecurityGroups(
      "Create RDS postgres with sg-0a1b2c3d4e5f67890 and sg-0fedcba9876543210",
      RESOURCE_TYPES.RDS_DB_INSTANCE,
      elicited,
      advisories,
    );

    const sgs = elicited["VPCSecurityGroups"] as string[];
    expect(sgs).toHaveLength(2);
    expect(sgs).toContain("sg-0a1b2c3d4e5f67890");
    expect(sgs).toContain("sg-0fedcba9876543210");
  });

  it("Axis G-2: multiple SGs → length matches input count", () => {
    const elicited: Record<string, unknown> = {};
    const advisories: Advisory[] = [];

    extractRdsVpcSecurityGroups(
      "Create RDS using sg-00000001 sg-00000002 sg-00000003",
      RESOURCE_TYPES.RDS_DB_INSTANCE,
      elicited,
      advisories,
    );

    const sgs = elicited["VPCSecurityGroups"] as string[];
    expect(sgs).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Axis H — Non-RDS resource types are unaffected
// ---------------------------------------------------------------------------

describe("Axis H — Non-RDS resource types: extractor is a no-op", () => {
  it("Axis H-1: S3 intent is unaffected", () => {
    const elicited: Record<string, unknown> = {};
    const advisories: Advisory[] = [];

    extractRdsVpcSecurityGroups(
      "Create an S3 bucket for static website",
      RESOURCE_TYPES.S3_BUCKET,
      elicited,
      advisories,
    );

    expect(Object.keys(elicited)).toHaveLength(0);
    expect(advisories).toHaveLength(0);
  });

  it("Axis H-2: Lambda intent is unaffected", () => {
    const elicited: Record<string, unknown> = {};
    const advisories: Advisory[] = [];

    extractRdsVpcSecurityGroups(
      "Create a Lambda hello world function",
      RESOURCE_TYPES.LAMBDA_FUNCTION,
      elicited,
      advisories,
    );

    expect(Object.keys(elicited)).toHaveLength(0);
    expect(advisories).toHaveLength(0);
  });

  it("Axis H-3: EC2 instance intent is unaffected", () => {
    const elicited: Record<string, unknown> = {};
    const advisories: Advisory[] = [];

    extractRdsVpcSecurityGroups(
      "Create an EC2 t3.micro instance with SSH",
      RESOURCE_TYPES.EC2_INSTANCE,
      elicited,
      advisories,
    );

    expect(Object.keys(elicited)).toHaveLength(0);
    expect(advisories).toHaveLength(0);
  });

  it("Axis H-4: ALL supported non-RDS types are unaffected (variant-matrix)", () => {
    // Variant-matrix harness: enumerate all supported types and confirm
    // the extractor is a no-op for every non-RDS type.
    const allTypes = enumerateTypes();
    const nonRdsTypes = allTypes.filter(
      (t) => t !== RESOURCE_TYPES.RDS_DB_INSTANCE,
    );

    for (const resourceType of nonRdsTypes) {
      const elicited: Record<string, unknown> = {};
      const advisories: Advisory[] = [];

      extractRdsVpcSecurityGroups(
        "Create a resource without security groups",
        resourceType,
        elicited,
        advisories,
      );

      expect(Object.keys(elicited)).toHaveLength(0);
      expect(advisories).toHaveLength(0);
    }
  });
});

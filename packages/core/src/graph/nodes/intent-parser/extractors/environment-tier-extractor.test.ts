import { describe, it, expect } from "vitest";
import { RESOURCE_TYPES } from "@/index.js";
import type { Advisory } from "../intent-types.js";
import {
  extractEnvironmentTier,
  applyRdsTierDefaults,
} from "./environment-tier-extractor.js";

// ---------------------------------------------------------------------------
// extractEnvironmentTier — pure tier detection with word-boundary guards
// ---------------------------------------------------------------------------

describe("extractEnvironmentTier", () => {
  it("returns 'staging' for 'for staging' phrase", () => {
    expect(
      extractEnvironmentTier("Create an RDS Postgres db.t3.micro for staging"),
    ).toBe("staging");
  });

  it("returns 'staging' for 'in staging'", () => {
    expect(extractEnvironmentTier("RDS database in staging environment")).toBe(
      "staging",
    );
  });

  it("staging is case-insensitive", () => {
    expect(extractEnvironmentTier("Create RDS for Staging")).toBe("staging");
  });

  it("returns 'dev' for 'for dev' phrase", () => {
    expect(
      extractEnvironmentTier("Create an RDS MySQL db.t3.small for dev"),
    ).toBe("dev");
  });

  it("returns 'dev' for 'in development'", () => {
    expect(extractEnvironmentTier("Postgres RDS instance in development")).toBe(
      "dev",
    );
  });

  it("returns 'dev' for 'for development'", () => {
    expect(
      extractEnvironmentTier("Create an RDS Postgres for development"),
    ).toBe("dev");
  });

  it("returns 'production' for 'for production' phrase", () => {
    expect(
      extractEnvironmentTier("Create an RDS Postgres for production"),
    ).toBe("production");
  });

  it("returns 'production' for 'in prod'", () => {
    expect(extractEnvironmentTier("RDS MySQL instance in prod")).toBe(
      "production",
    );
  });

  it("returns 'production' for 'for prod'", () => {
    expect(extractEnvironmentTier("Create RDS Postgres for prod")).toBe(
      "production",
    );
  });

  it("returns null when no tier hint is present", () => {
    expect(extractEnvironmentTier("Create an RDS Postgres")).toBeNull();
  });

  it("returns null for empty intent", () => {
    expect(extractEnvironmentTier("")).toBeNull();
  });

  // Variation F — word-boundary negative
  it("Variation F — 'stagingZ' does NOT match (word boundary required)", () => {
    expect(
      extractEnvironmentTier("Create an RDS Postgres for stagingZ"),
    ).toBeNull();
  });

  it("Variation F — 'productionenv' does NOT match production", () => {
    expect(
      extractEnvironmentTier("Create RDS Postgres for productionenv"),
    ).toBeNull();
  });

  it("Variation F — 'devX' does NOT match dev", () => {
    expect(extractEnvironmentTier("Create RDS for devX")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// applyRdsTierDefaults — RDS-specific tier defaults + advisory injection
// ---------------------------------------------------------------------------

describe("applyRdsTierDefaults", () => {
  const RDS_TYPE = RESOURCE_TYPES.RDS_DB_INSTANCE;

  // Variation A — "for staging"
  it("Variation A — staging sets MultiAZ=false, DeletionProtection=false, BackupRetentionPeriod=1", () => {
    const elicited: Record<string, unknown> = {};
    const advisories: Advisory[] = [];
    applyRdsTierDefaults(
      "Create an RDS Postgres db.t3.micro for staging",
      RDS_TYPE,
      elicited,
      advisories,
    );
    expect(elicited["MultiAZ"]).toBe(false);
    expect(elicited["DeletionProtection"]).toBe(false);
    expect(elicited["BackupRetentionPeriod"]).toBe(1);
    expect(elicited["PerformanceInsightsEnabled"]).toBe(false);
    expect(advisories).toHaveLength(1);
    expect(advisories[0]!.code).toBe("RDS_ENVIRONMENT_TIER_DEFAULTS");
    expect(advisories[0]!.message).toContain("staging");
  });

  // Variation B — "for dev"
  it("Variation B — dev sets MultiAZ=false, DeletionProtection=false, BackupRetentionPeriod=1", () => {
    const elicited: Record<string, unknown> = {};
    const advisories: Advisory[] = [];
    applyRdsTierDefaults(
      "Create an RDS MySQL db.t3.small for dev",
      RDS_TYPE,
      elicited,
      advisories,
    );
    expect(elicited["MultiAZ"]).toBe(false);
    expect(elicited["DeletionProtection"]).toBe(false);
    expect(elicited["BackupRetentionPeriod"]).toBe(1);
    expect(elicited["PerformanceInsightsEnabled"]).toBe(false);
    expect(advisories[0]!.message).toContain("dev");
  });

  // Variation C — "for production"
  it("Variation C — production sets MultiAZ=true, DeletionProtection=true, BackupRetentionPeriod=7", () => {
    const elicited: Record<string, unknown> = {};
    const advisories: Advisory[] = [];
    applyRdsTierDefaults(
      "Create an RDS Postgres for production",
      RDS_TYPE,
      elicited,
      advisories,
    );
    expect(elicited["MultiAZ"]).toBe(true);
    expect(elicited["DeletionProtection"]).toBe(true);
    expect(elicited["BackupRetentionPeriod"]).toBe(7);
    expect(elicited["PerformanceInsightsEnabled"]).toBe(true);
    expect(advisories[0]!.message).toContain("production");
  });

  // Variation D — no tier hint
  it("Variation D — no tier hint leaves elicited untouched, no advisory", () => {
    const elicited: Record<string, unknown> = {};
    const advisories: Advisory[] = [];
    applyRdsTierDefaults(
      "Create an RDS Postgres",
      RDS_TYPE,
      elicited,
      advisories,
    );
    expect(elicited).toEqual({});
    expect(advisories).toHaveLength(0);
  });

  // Variation E — explicit "with MultiAZ" overrides staging default
  it("Variation E — 'with MultiAZ' keyword overrides staging tier default", () => {
    const elicited: Record<string, unknown> = {};
    const advisories: Advisory[] = [];
    applyRdsTierDefaults(
      "Create an RDS Postgres for staging with MultiAZ",
      RDS_TYPE,
      elicited,
      advisories,
    );
    expect(elicited["MultiAZ"]).toBe(true);
    // other staging defaults still apply
    expect(elicited["DeletionProtection"]).toBe(false);
    expect(elicited["BackupRetentionPeriod"]).toBe(1);
  });

  // Variation F — partial match must NOT trigger
  it("Variation F — 'stagingZ' does not trigger tier defaults", () => {
    const elicited: Record<string, unknown> = {};
    const advisories: Advisory[] = [];
    applyRdsTierDefaults(
      "Create an RDS Postgres for stagingZ",
      RDS_TYPE,
      elicited,
      advisories,
    );
    expect(elicited).toEqual({});
    expect(advisories).toHaveLength(0);
  });

  it("does nothing for non-RDS resource types", () => {
    const elicited: Record<string, unknown> = {};
    const advisories: Advisory[] = [];
    applyRdsTierDefaults(
      "Create an S3 bucket for staging",
      RESOURCE_TYPES.S3_BUCKET,
      elicited,
      advisories,
    );
    expect(elicited).toEqual({});
    expect(advisories).toHaveLength(0);
  });

  it("pre-set elicited values are not overwritten by tier defaults", () => {
    const elicited: Record<string, unknown> = { MultiAZ: true };
    const advisories: Advisory[] = [];
    applyRdsTierDefaults(
      "Create an RDS Postgres for staging",
      RDS_TYPE,
      elicited,
      advisories,
    );
    // MultiAZ was already set to true — tier default must NOT overwrite
    expect(elicited["MultiAZ"]).toBe(true);
    // Other staging defaults still apply
    expect(elicited["DeletionProtection"]).toBe(false);
  });

  it("advisory message contains tier name and override hint", () => {
    const elicited: Record<string, unknown> = {};
    const advisories: Advisory[] = [];
    applyRdsTierDefaults(
      "Create an RDS Postgres for staging",
      RDS_TYPE,
      elicited,
      advisories,
    );
    expect(advisories[0]!.message).toMatch(/staging/);
    expect(advisories[0]!.message).toContain("--set MultiAZ=true");
    expect(advisories[0]!.hint).toContain("BackupRetentionPeriod");
  });
});

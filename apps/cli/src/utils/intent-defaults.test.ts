import { describe, it, expect } from "vitest";
import { RESOURCE_TYPES } from "@assignee/core";
import { getIntentDefaults } from "./intent-defaults.js";

describe("getIntentDefaults", () => {
  // ── Task 3.1 / AC #3: Lambda API handler defaults ─────────────────────

  it('returns MemorySize=512 and Timeout=30 for "api handler" intent', () => {
    const overrides = getIntentDefaults(
      "I need an api handler for my REST service",
      RESOURCE_TYPES.LAMBDA_FUNCTION,
    );
    const memOverride = overrides.find((o) => o.fieldName === "MemorySize");
    const timeoutOverride = overrides.find((o) => o.fieldName === "Timeout");

    expect(memOverride).toBeDefined();
    expect(memOverride!.value).toBe("512");
    expect(timeoutOverride).toBeDefined();
    expect(timeoutOverride!.value).toBe("30");
  });

  it('returns MemorySize=512 and Timeout=30 for "api endpoint" intent', () => {
    const overrides = getIntentDefaults(
      "create an api endpoint",
      RESOURCE_TYPES.LAMBDA_FUNCTION,
    );
    expect(overrides.find((o) => o.fieldName === "MemorySize")!.value).toBe(
      "512",
    );
    expect(overrides.find((o) => o.fieldName === "Timeout")!.value).toBe("30");
  });

  // ── Task 3.1 / AC #3: Lambda background job defaults ──────────────────

  it('returns Timeout=300 for "background job" intent', () => {
    const overrides = getIntentDefaults(
      "set up a background job processor",
      RESOURCE_TYPES.LAMBDA_FUNCTION,
    );
    const timeoutOverride = overrides.find((o) => o.fieldName === "Timeout");
    expect(timeoutOverride).toBeDefined();
    expect(timeoutOverride!.value).toBe("300");
  });

  it('returns Timeout=300 for "worker" intent', () => {
    const overrides = getIntentDefaults(
      "create a worker function",
      RESOURCE_TYPES.LAMBDA_FUNCTION,
    );
    const timeoutOverride = overrides.find((o) => o.fieldName === "Timeout");
    expect(timeoutOverride).toBeDefined();
    expect(timeoutOverride!.value).toBe("300");
  });

  it("does not return MemorySize override for worker intent", () => {
    const overrides = getIntentDefaults(
      "create a worker function",
      RESOURCE_TYPES.LAMBDA_FUNCTION,
    );
    const memOverride = overrides.find((o) => o.fieldName === "MemorySize");
    expect(memOverride).toBeUndefined();
  });

  // ── Task 6.1 / AC #9: RDS production defaults ─────────────────────────

  it('returns MultiAZ, BackupRetentionPeriod, DeletionProtection for "production database"', () => {
    const overrides = getIntentDefaults(
      "set up a production database",
      RESOURCE_TYPES.RDS_DB_INSTANCE,
    );
    expect(overrides.find((o) => o.fieldName === "MultiAZ")!.value).toBe(true);
    expect(
      overrides.find((o) => o.fieldName === "BackupRetentionPeriod")!.value,
    ).toBe("7");
    expect(
      overrides.find((o) => o.fieldName === "DeletionProtection")!.value,
    ).toBe(true);
  });

  it('returns MultiAZ, BackupRetentionPeriod, DeletionProtection for "prod db"', () => {
    const overrides = getIntentDefaults(
      "I need a prod db for my app",
      RESOURCE_TYPES.RDS_DB_INSTANCE,
    );
    expect(overrides.find((o) => o.fieldName === "MultiAZ")!.value).toBe(true);
    expect(
      overrides.find((o) => o.fieldName === "DeletionProtection")!.value,
    ).toBe(true);
  });

  // ── Task 6.1 / AC #9: RDS dev defaults ────────────────────────────────

  it('returns MultiAZ=false for "dev database"', () => {
    const overrides = getIntentDefaults(
      "create a dev database",
      RESOURCE_TYPES.RDS_DB_INSTANCE,
    );
    const multiAz = overrides.find((o) => o.fieldName === "MultiAZ");
    expect(multiAz).toBeDefined();
    expect(multiAz!.value).toBe(false);
  });

  it('returns MultiAZ=false for "dev db"', () => {
    const overrides = getIntentDefaults(
      "I need a dev db",
      RESOURCE_TYPES.RDS_DB_INSTANCE,
    );
    const multiAz = overrides.find((o) => o.fieldName === "MultiAZ");
    expect(multiAz).toBeDefined();
    expect(multiAz!.value).toBe(false);
  });

  // ── Edge cases ─────────────────────────────────────────────────────────

  it("returns empty array for unrelated intent", () => {
    const overrides = getIntentDefaults(
      "something random",
      RESOURCE_TYPES.LAMBDA_FUNCTION,
    );
    expect(overrides).toEqual([]);
  });

  it("returns empty array for empty intent", () => {
    const overrides = getIntentDefaults("", RESOURCE_TYPES.LAMBDA_FUNCTION);
    expect(overrides).toEqual([]);
  });

  // ── Story 18.12: categoryHint on EC2 intent overrides ───────────────────

  it('EC2 "web server" override includes categoryHint: "burstable"', () => {
    const overrides = getIntentDefaults(
      "Create an EC2 for web server",
      RESOURCE_TYPES.EC2_INSTANCE,
    );
    expect(overrides).toHaveLength(1);
    expect(overrides[0]!.categoryHint).toBe("burstable");
  });

  it('EC2 "machine learning" override includes categoryHint: "compute"', () => {
    const overrides = getIntentDefaults(
      "Create an EC2 for machine learning",
      RESOURCE_TYPES.EC2_INSTANCE,
    );
    expect(overrides).toHaveLength(1);
    expect(overrides[0]!.categoryHint).toBe("compute");
  });

  it('EC2 "database" override includes categoryHint: "memory"', () => {
    const overrides = getIntentDefaults(
      "Create an EC2 for database",
      RESOURCE_TYPES.EC2_INSTANCE,
    );
    expect(overrides).toHaveLength(1);
    expect(overrides[0]!.categoryHint).toBe("memory");
  });

  it("S3 overrides do not have categoryHint", () => {
    const overrides = getIntentDefaults(
      "Create S3 for static website hosting",
      RESOURCE_TYPES.S3_BUCKET,
    );
    expect(overrides.length).toBeGreaterThan(0);
    for (const o of overrides) {
      expect(o.categoryHint).toBeUndefined();
    }
  });
});

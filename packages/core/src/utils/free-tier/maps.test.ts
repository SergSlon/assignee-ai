/**
 * Tests for free-tier/maps.ts — RDS instance-class detector (RG-2 / DF-E6).
 *
 * Five probe variations covering the full free-tier class boundary:
 *   A  db.t3.micro  — free-tier YES
 *   B  db.t2.micro  — free-tier YES
 *   C  db.t4g.micro — NOT free (Graviton micro, not covered by AWS free tier)
 *   D  db.t3.medium — NOT free (medium class, exceeds free-tier spec)
 *   E  storage note — RDS_FREE_TIER_STORAGE_NOTE present for free-tier instance
 *
 * Also covers the static class set (`RDS_FREE_TIER_INSTANCE_CLASSES`) and
 * the pure snapshot accessor (`getFreeTierMaps`).
 */

import { describe, it, expect } from "vitest";
import {
  isRdsInstanceClassFreeTierEligible,
  RDS_FREE_TIER_INSTANCE_CLASSES,
  RDS_FREE_TIER_STORAGE_NOTE,
  getFreeTierMaps,
} from "./maps.js";

// ── Probe Variation A — db.t3.micro is free-tier eligible ────────────────────

describe("isRdsInstanceClassFreeTierEligible — Variation A (db.t3.micro)", () => {
  it("returns true for db.t3.micro", () => {
    expect(isRdsInstanceClassFreeTierEligible("db.t3.micro")).toBe(true);
  });

  it("db.t3.micro is present in RDS_FREE_TIER_INSTANCE_CLASSES set", () => {
    expect(RDS_FREE_TIER_INSTANCE_CLASSES.has("db.t3.micro")).toBe(true);
  });
});

// ── Probe Variation B — db.t2.micro is free-tier eligible ────────────────────

describe("isRdsInstanceClassFreeTierEligible — Variation B (db.t2.micro)", () => {
  it("returns true for db.t2.micro", () => {
    expect(isRdsInstanceClassFreeTierEligible("db.t2.micro")).toBe(true);
  });

  it("db.t2.micro is present in RDS_FREE_TIER_INSTANCE_CLASSES set", () => {
    expect(RDS_FREE_TIER_INSTANCE_CLASSES.has("db.t2.micro")).toBe(true);
  });
});

// ── Probe Variation C — db.t4g.micro is NOT free (Graviton) ─────────────────

describe("isRdsInstanceClassFreeTierEligible — Variation C (db.t4g.micro NOT free)", () => {
  it("returns false for db.t4g.micro", () => {
    expect(isRdsInstanceClassFreeTierEligible("db.t4g.micro")).toBe(false);
  });

  it("db.t4g.micro is absent from RDS_FREE_TIER_INSTANCE_CLASSES set", () => {
    expect(RDS_FREE_TIER_INSTANCE_CLASSES.has("db.t4g.micro")).toBe(false);
  });
});

// ── Probe Variation D — db.t3.medium is NOT free ─────────────────────────────

describe("isRdsInstanceClassFreeTierEligible — Variation D (db.t3.medium NOT free)", () => {
  it("returns false for db.t3.medium", () => {
    expect(isRdsInstanceClassFreeTierEligible("db.t3.medium")).toBe(false);
  });

  it("db.t3.medium is absent from RDS_FREE_TIER_INSTANCE_CLASSES set", () => {
    expect(RDS_FREE_TIER_INSTANCE_CLASSES.has("db.t3.medium")).toBe(false);
  });
});

// ── Probe Variation E — storage free-tier note present ───────────────────────

describe("RDS_FREE_TIER_STORAGE_NOTE — Variation E (20 GB GP2 storage note)", () => {
  it("is a non-empty string", () => {
    expect(typeof RDS_FREE_TIER_STORAGE_NOTE).toBe("string");
    expect(RDS_FREE_TIER_STORAGE_NOTE.length).toBeGreaterThan(0);
  });

  it("mentions 20 GB GP2 storage", () => {
    expect(RDS_FREE_TIER_STORAGE_NOTE).toMatch(/20\s*GB/i);
    expect(RDS_FREE_TIER_STORAGE_NOTE).toMatch(/GP2/i);
  });

  it("can be surfaced alongside a free-tier eligible instance (db.t3.micro)", () => {
    // When db.t3.micro is free, the storage note should be surfaced.
    const instanceIsFree = isRdsInstanceClassFreeTierEligible("db.t3.micro");
    const storageNote = instanceIsFree ? RDS_FREE_TIER_STORAGE_NOTE : null;
    expect(instanceIsFree).toBe(true);
    expect(storageNote).not.toBeNull();
    expect(storageNote).toMatch(/20\s*GB/i);
  });

  it("is NOT surfaced for a non-free-tier instance (db.t4g.micro)", () => {
    // When the instance class is not free-tier, no storage note applies.
    const instanceIsFree = isRdsInstanceClassFreeTierEligible("db.t4g.micro");
    const storageNote = instanceIsFree ? RDS_FREE_TIER_STORAGE_NOTE : null;
    expect(instanceIsFree).toBe(false);
    expect(storageNote).toBeNull();
  });
});

// ── Static set invariants ─────────────────────────────────────────────────────

describe("RDS_FREE_TIER_INSTANCE_CLASSES", () => {
  it("contains exactly the two AWS-documented free-tier classes", () => {
    expect(RDS_FREE_TIER_INSTANCE_CLASSES.size).toBe(2);
    expect(RDS_FREE_TIER_INSTANCE_CLASSES.has("db.t2.micro")).toBe(true);
    expect(RDS_FREE_TIER_INSTANCE_CLASSES.has("db.t3.micro")).toBe(true);
  });

  it("is a ReadonlySet (runtime check: Set instance)", () => {
    expect(RDS_FREE_TIER_INSTANCE_CLASSES).toBeInstanceOf(Set);
  });

  it("does not include db.t4g.micro (Graviton — not in AWS free tier)", () => {
    expect(RDS_FREE_TIER_INSTANCE_CLASSES.has("db.t4g.micro")).toBe(false);
  });

  it("does not include any medium/large classes", () => {
    const nonFreeClasses = [
      "db.t3.medium",
      "db.t3.large",
      "db.t2.medium",
      "db.t2.large",
      "db.m5.large",
      "db.r5.large",
    ];
    for (const cls of nonFreeClasses) {
      expect(RDS_FREE_TIER_INSTANCE_CLASSES.has(cls)).toBe(false);
    }
  });
});

// ── getFreeTierMaps legacy-eligible map includes RDS ─────────────────────────

describe("getFreeTierMaps — RDS entry", () => {
  it("legacyEligible map contains AWS::RDS::DBInstance", () => {
    const { legacyEligible } = getFreeTierMaps();
    expect(legacyEligible["AWS::RDS::DBInstance"]).toBeTruthy();
  });

  it("legacyEligible RDS entry mentions db.t2.micro and db.t3.micro", () => {
    const { legacyEligible } = getFreeTierMaps();
    const entry = legacyEligible["AWS::RDS::DBInstance"] ?? "";
    expect(entry).toMatch(/db\.t2\.micro/);
    expect(entry).toMatch(/db\.t3\.micro/);
  });

  it("legacyEligible RDS entry mentions 750 hrs", () => {
    const { legacyEligible } = getFreeTierMaps();
    const entry = legacyEligible["AWS::RDS::DBInstance"] ?? "";
    expect(entry).toMatch(/750/);
  });
});

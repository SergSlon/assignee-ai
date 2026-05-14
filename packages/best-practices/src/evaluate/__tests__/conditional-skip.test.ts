/**
 * Tests for advisor-gated BP suppression (EPIC-106-6 / PH5-3-B).
 *
 * Variations:
 *   A — staging intent + RDS_ENVIRONMENT_TIER_DEFAULTS advisory → suppressed
 *   B — production intent (no advisory) → fires HIGH as before
 *   C — no tier hint (no advisory) → fires HIGH as before
 *   D — security rule (no skip_when_advisory) → always fires regardless of advisory
 */

import { describe, it, expect } from "vitest";
import { evaluateTriggers } from "../barrel.js";
import type { EvalContext } from "../context-builder.js";
import type { BestPractice } from "../../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRdsCtx(overrides: Partial<EvalContext> = {}): EvalContext {
  return {
    resourceType: "AWS::RDS::DBInstance",
    desiredState: { MultiAZ: false, DeletionProtection: false },
    ...overrides,
  };
}

/** BP-RDS-003 equivalent: MultiAZ required, suppressed by RDS_ENVIRONMENT_TIER_DEFAULTS */
function makeMultiAzBp(): BestPractice {
  return {
    id: "BP-RDS-003",
    title: "RDS instance should have Multi-AZ deployment enabled",
    severity: "HIGH",
    resource_type: "AWS::RDS::DBInstance",
    property_path: "MultiAZ",
    check_type: "equals",
    expected_value: true,
    source: "AWS Security Hub FSBP",
    source_id: "RDS.5",
    description: "Multi-AZ required for production HA.",
    remediation: "Set MultiAZ to true.",
    category: "reliability",
    lastVerified: "2026-03-22",
    skip_when_advisory: ["RDS_ENVIRONMENT_TIER_DEFAULTS"],
  };
}

/** BP-RDS-004 equivalent: DeletionProtection required, suppressed by RDS_ENVIRONMENT_TIER_DEFAULTS */
function makeDeletionProtectionBp(): BestPractice {
  return {
    id: "BP-RDS-004",
    title: "RDS instance should have deletion protection enabled",
    severity: "HIGH",
    resource_type: "AWS::RDS::DBInstance",
    property_path: "DeletionProtection",
    check_type: "equals",
    expected_value: true,
    source: "AWS Security Hub FSBP",
    source_id: "RDS.8",
    description: "DeletionProtection guards against accidental removal.",
    remediation: "Set DeletionProtection to true.",
    category: "reliability",
    lastVerified: "2026-03-22",
    skip_when_advisory: ["RDS_ENVIRONMENT_TIER_DEFAULTS"],
  };
}

/** BP-RDS-002 equivalent: encryption — compliance-critical, no skip_when_advisory */
function makeEncryptionBp(): BestPractice {
  return {
    id: "BP-RDS-002",
    title: "RDS instance should have encryption at rest enabled",
    severity: "CRITICAL",
    resource_type: "AWS::RDS::DBInstance",
    property_path: "StorageEncrypted",
    check_type: "equals",
    expected_value: true,
    source: "AWS Security Hub FSBP",
    source_id: "RDS.3",
    description: "Encryption at rest protects data from storage compromise.",
    remediation: "Set StorageEncrypted to true.",
    category: "security",
    lastVerified: "2026-03-22",
    blocking: true,
  };
}

// ---------------------------------------------------------------------------
// Variation A: staging + RDS_ENVIRONMENT_TIER_DEFAULTS advisory → suppressed
// ---------------------------------------------------------------------------

describe("BP advisor-gated suppression — Variation A (staging intent, advisory present)", () => {
  it("suppresses MultiAZ rule when RDS_ENVIRONMENT_TIER_DEFAULTS advisory is present", () => {
    const ctx = makeRdsCtx({
      userIntent: "Create an RDS Postgres db.t3.micro for staging",
      desiredState: { MultiAZ: false },
      advisorCodes: ["RDS_ENVIRONMENT_TIER_DEFAULTS"],
    });

    const findings = evaluateTriggers(ctx, [makeMultiAzBp()]);
    expect(findings).toHaveLength(0);
  });

  it("suppresses DeletionProtection rule when RDS_ENVIRONMENT_TIER_DEFAULTS advisory is present", () => {
    const ctx = makeRdsCtx({
      userIntent: "Create an RDS Postgres db.t3.micro for staging",
      desiredState: { DeletionProtection: false },
      advisorCodes: ["RDS_ENVIRONMENT_TIER_DEFAULTS"],
    });

    const findings = evaluateTriggers(ctx, [makeDeletionProtectionBp()]);
    expect(findings).toHaveLength(0);
  });

  it("suppresses multiple production-grade rules simultaneously when advisory is present", () => {
    const ctx = makeRdsCtx({
      userIntent: "Create an RDS Postgres db.t3.micro for staging",
      desiredState: { MultiAZ: false, DeletionProtection: false },
      advisorCodes: ["RDS_ENVIRONMENT_TIER_DEFAULTS"],
    });

    const findings = evaluateTriggers(ctx, [
      makeMultiAzBp(),
      makeDeletionProtectionBp(),
    ]);
    expect(findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Variation B: production intent (no advisory emitted) → rules fire
// ---------------------------------------------------------------------------

describe("BP advisor-gated suppression — Variation B (production intent, no advisory)", () => {
  it("fires MultiAZ rule for production intent when MultiAZ is false", () => {
    const ctx = makeRdsCtx({
      userIntent: "Create an RDS Postgres db.t3.micro for production",
      desiredState: { MultiAZ: false },
      advisorCodes: [],
    });

    const findings = evaluateTriggers(ctx, [makeMultiAzBp()]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.practiceId).toBe("BP-RDS-003");
    expect(findings[0]!.severity).toBe("HIGH");
  });

  it("fires DeletionProtection rule for production intent when DeletionProtection is false", () => {
    const ctx = makeRdsCtx({
      userIntent: "Create an RDS Postgres db.t3.micro for production",
      desiredState: { DeletionProtection: false },
      advisorCodes: [],
    });

    const findings = evaluateTriggers(ctx, [makeDeletionProtectionBp()]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.practiceId).toBe("BP-RDS-004");
    expect(findings[0]!.severity).toBe("HIGH");
  });
});

// ---------------------------------------------------------------------------
// Variation C: no tier hint (advisorCodes absent / empty) → rules fire
// ---------------------------------------------------------------------------

describe("BP advisor-gated suppression — Variation C (no tier hint, no advisory codes)", () => {
  it("fires MultiAZ rule when advisorCodes is undefined", () => {
    const ctx = makeRdsCtx({
      userIntent: "Create an RDS Postgres database",
      desiredState: { MultiAZ: false },
      advisorCodes: undefined,
    });

    const findings = evaluateTriggers(ctx, [makeMultiAzBp()]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.practiceId).toBe("BP-RDS-003");
  });

  it("fires MultiAZ rule when advisorCodes is empty array", () => {
    const ctx = makeRdsCtx({
      userIntent: "Create an RDS Postgres database",
      desiredState: { MultiAZ: false },
      advisorCodes: [],
    });

    const findings = evaluateTriggers(ctx, [makeMultiAzBp()]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.practiceId).toBe("BP-RDS-003");
  });

  it("fires when advisor code is different from the rule's skip_when_advisory list", () => {
    const ctx = makeRdsCtx({
      desiredState: { MultiAZ: false },
      advisorCodes: ["SOME_OTHER_ADVISOR"],
    });

    const findings = evaluateTriggers(ctx, [makeMultiAzBp()]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.practiceId).toBe("BP-RDS-003");
  });
});

// ---------------------------------------------------------------------------
// Variation D: compliance-critical rules (no skip_when_advisory) always fire
// ---------------------------------------------------------------------------

describe("BP advisor-gated suppression — Variation D (compliance-critical rules not suppressed)", () => {
  it("encryption rule fires even when RDS_ENVIRONMENT_TIER_DEFAULTS advisory is present", () => {
    const ctx = makeRdsCtx({
      userIntent: "Create an RDS Postgres db.t3.micro for staging",
      desiredState: { StorageEncrypted: false },
      advisorCodes: ["RDS_ENVIRONMENT_TIER_DEFAULTS"],
    });

    const findings = evaluateTriggers(ctx, [makeEncryptionBp()]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.practiceId).toBe("BP-RDS-002");
    expect(findings[0]!.severity).toBe("CRITICAL");
    expect(findings[0]!.blocking).toBe(true);
  });

  it("encryption rule fires regardless of any advisor code", () => {
    const ctx = makeRdsCtx({
      desiredState: { StorageEncrypted: false },
      advisorCodes: [
        "RDS_ENVIRONMENT_TIER_DEFAULTS",
        "SOME_OTHER_ADVISOR",
        "ANY_ADVISOR",
      ],
    });

    const findings = evaluateTriggers(ctx, [makeEncryptionBp()]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.practiceId).toBe("BP-RDS-002");
  });

  it("encryption + MultiAZ: encryption fires, MultiAZ suppressed when advisory present", () => {
    const ctx = makeRdsCtx({
      userIntent: "Create an RDS Postgres for staging",
      desiredState: { StorageEncrypted: false, MultiAZ: false },
      advisorCodes: ["RDS_ENVIRONMENT_TIER_DEFAULTS"],
    });

    const findings = evaluateTriggers(ctx, [
      makeEncryptionBp(),
      makeMultiAzBp(),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.practiceId).toBe("BP-RDS-002");
  });
});

import { describe, it, expect } from "vitest";
import {
  COMPOUND_SUPPRESSIONS,
  INTENT_BASED_SUPPRESSIONS,
  suppressCompoundFindings,
  suppressIntentFindings,
} from "./compound-suppressor.js";
import type { BPFinding } from "@assignee/best-practices";

// Build a real-shape BPFinding with all required fields. We only need
// `practiceId` for the suppression filter, but the test uses the full
// shape so it stays honest with the production type.
function finding(practiceId: string): BPFinding {
  return {
    practiceId,
    title: `Synthetic finding for ${practiceId}`,
    severity: "HIGH",
    category: "security",
    message: `Synthetic message for ${practiceId}`,
    blocking: false,
    propertyPath: "/Properties/Test",
  } as BPFinding;
}

describe("suppressCompoundFindings (patternId-gated)", () => {
  it("returns findings unchanged when patternId is undefined", () => {
    const fs = [finding("BP-IGW-001"), finding("BP-EC2-001")];
    const r = suppressCompoundFindings(fs, undefined);
    expect(r.findings).toHaveLength(2);
    expect(r.suppressedCount).toBe(0);
  });

  it("returns findings unchanged when patternId is unknown", () => {
    const fs = [finding("BP-IGW-001"), finding("BP-EC2-001")];
    const r = suppressCompoundFindings(fs, "no-such-pattern");
    expect(r.findings).toHaveLength(2);
    expect(r.suppressedCount).toBe(0);
  });

  it("filters out the per-pattern suppression set for vpc-networking", () => {
    const fs = [
      finding("BP-IGW-001"),
      finding("BP-IGW-002"),
      finding("BP-RT-001"),
      finding("BP-RT-002"),
      finding("BP-NAT-003"),
      finding("BP-EC2-001"), // not in the set
    ];
    const r = suppressCompoundFindings(fs, "vpc-networking");
    expect(r.findings.map((f) => f.practiceId)).toEqual(["BP-EC2-001"]);
    expect(r.suppressedCount).toBe(5);
  });

  it("vpc-public-only suppresses only IGW + RT-002 (no NAT, no RT-001)", () => {
    const fs = [
      finding("BP-IGW-001"),
      finding("BP-IGW-002"),
      finding("BP-RT-001"),
      finding("BP-RT-002"),
      finding("BP-NAT-003"),
    ];
    const r = suppressCompoundFindings(fs, "vpc-public-only");
    expect(r.findings.map((f) => f.practiceId)).toEqual([
      "BP-RT-001",
      "BP-NAT-003",
    ]);
    expect(r.suppressedCount).toBe(3);
  });

  it("preserves COMPOUND_SUPPRESSIONS shape (regression guard)", () => {
    expect(Object.keys(COMPOUND_SUPPRESSIONS).sort()).toEqual([
      "container-service",
      "three-tier-web",
      "vpc-networking",
      "vpc-public-only",
    ]);
  });
});

describe("suppressIntentFindings (intent-based, INTENT_BASED_SUPPRESSIONS)", () => {
  const sshState: Record<string, unknown> = {
    IamInstanceProfile: "assignee-ssh-abcdef12",
  };

  it("exposes the SSH-bundle entry as the first INTENT_BASED_SUPPRESSIONS row", () => {
    expect(INTENT_BASED_SUPPRESSIONS).toHaveLength(1);
    const e = INTENT_BASED_SUPPRESSIONS[0]!;
    expect(e.intentRegex.source).toBe("\\bssh\\b");
    expect(e.intentRegex.flags).toContain("i");
    // Pre-demo audit (2026-05-05): the SSH-bundle entry now omits
    // `mustHaveDesiredKey` because `bp_evaluator` runs at PLAN time but
    // `ensureSshIamProfile` only populates `desiredState.IamInstanceProfile`
    // at APPLY time — the guard would always fail and BP-EC2-004 would
    // fire spuriously in the plan box.
    expect(e.mustHaveDesiredKey).toBeUndefined();
    expect(e.suppressIds).toEqual(["BP-EC2-004"]);
  });

  it("suppresses BP-EC2-004 when SSH intent is present (desiredState populated)", () => {
    const fs = [finding("BP-EC2-004"), finding("BP-EC2-001")];
    const r = suppressIntentFindings(fs, "Create a EC2 with SSH", sshState);
    expect(r.findings.map((f) => f.practiceId)).toEqual(["BP-EC2-001"]);
    expect(r.suppressedCount).toBe(1);
  });

  it("suppresses BP-EC2-004 at plan time even when IamInstanceProfile is empty (Phase-2 pre-hook hasn't run yet)", () => {
    // Pre-demo audit (2026-05-05): the inverted assertion. Previously the
    // guard required `desiredState.IamInstanceProfile` to be populated;
    // because `bp_evaluator` runs at plan time and the SSH-IAM pre-hook
    // runs at apply time, the guard always failed for the canonical
    // "Create EC2 with SSH" intent and BP-EC2-004 fired spuriously.
    const fs = [finding("BP-EC2-004"), finding("BP-EC2-001")];
    const r = suppressIntentFindings(fs, "Create a EC2 with SSH", {});
    expect(r.findings.map((f) => f.practiceId)).toEqual(["BP-EC2-001"]);
    expect(r.suppressedCount).toBe(1);
  });

  it("suppresses BP-EC2-004 even when IamInstanceProfile is whitespace-only (no longer guard-gated)", () => {
    const fs = [finding("BP-EC2-004")];
    const r = suppressIntentFindings(fs, "ssh me up", {
      IamInstanceProfile: "   ",
    });
    expect(r.findings).toHaveLength(0);
    expect(r.suppressedCount).toBe(1);
  });

  it("suppresses BP-EC2-004 when IamInstanceProfile is set to {Arn: ...} (no behaviour change for populated state)", () => {
    const fs = [finding("BP-EC2-004")];
    const r = suppressIntentFindings(fs, "ssh", {
      IamInstanceProfile: {
        Arn: "arn:aws:iam::123456789012:instance-profile/p",
      },
    });
    expect(r.findings).toHaveLength(0);
    expect(r.suppressedCount).toBe(1);
  });

  it("suppresses BP-EC2-004 when IamInstanceProfile is set to {Name: ...} (no behaviour change for populated state)", () => {
    const fs = [finding("BP-EC2-004")];
    const r = suppressIntentFindings(fs, "ssh", {
      IamInstanceProfile: { Name: "my-profile" },
    });
    expect(r.findings).toHaveLength(0);
    expect(r.suppressedCount).toBe(1);
  });

  it("does NOT suppress when intent has no 'ssh' word", () => {
    const fs = [finding("BP-EC2-004")];
    const r = suppressIntentFindings(fs, "Create a t3.micro EC2", sshState);
    expect(r.findings).toHaveLength(1);
    expect(r.suppressedCount).toBe(0);
  });

  it("does NOT match 'ssh' as a substring (word-boundary regex)", () => {
    const fs = [finding("BP-EC2-004")];
    const r = suppressIntentFindings(fs, "splashscreen", sshState);
    expect(r.findings).toHaveLength(1);
    expect(r.suppressedCount).toBe(0);
  });

  it("returns findings unchanged when userIntent is undefined", () => {
    const fs = [finding("BP-EC2-004")];
    const r = suppressIntentFindings(fs, undefined, sshState);
    expect(r.findings).toHaveLength(1);
    expect(r.suppressedCount).toBe(0);
  });

  it("returns findings unchanged when userIntent is empty string", () => {
    const fs = [finding("BP-EC2-004")];
    const r = suppressIntentFindings(fs, "", sshState);
    expect(r.findings).toHaveLength(1);
    expect(r.suppressedCount).toBe(0);
  });

  it("suppresses BP-EC2-004 even when desiredState is undefined (SSH entry has no desired-key guard)", () => {
    // Pre-demo audit (2026-05-05): inverted from the original
    // "returns unchanged" assertion. The SSH-bundle entry no longer
    // gates on desiredState — the intent alone is sufficient evidence
    // the apply-time pre-hook will satisfy BP-EC2-004.
    const fs = [finding("BP-EC2-004")];
    const r = suppressIntentFindings(fs, "ssh me", undefined);
    expect(r.findings).toHaveLength(0);
    expect(r.suppressedCount).toBe(1);
  });

  it("matches intent case-insensitively (SSH, Ssh)", () => {
    const fs = [finding("BP-EC2-004")];
    const r1 = suppressIntentFindings(fs, "Use SSH access", sshState);
    expect(r1.suppressedCount).toBe(1);
    const r2 = suppressIntentFindings(fs, "Ssh me", sshState);
    expect(r2.suppressedCount).toBe(1);
  });

  it("only filters listed practiceIds — leaves other findings intact", () => {
    const fs = [
      finding("BP-EC2-004"),
      finding("BP-EC2-001"),
      finding("BP-IAM-001"),
    ];
    const r = suppressIntentFindings(fs, "ssh", sshState);
    expect(r.findings.map((f) => f.practiceId)).toEqual([
      "BP-EC2-001",
      "BP-IAM-001",
    ]);
    expect(r.suppressedCount).toBe(1);
  });
});

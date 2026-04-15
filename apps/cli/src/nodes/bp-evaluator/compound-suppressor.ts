/**
 * Compound-pattern BP suppression.
 *
 * Several "structural" best-practices (IGW must be attached to a VPC,
 * NatGateway must be in a public subnet, etc.) fire on individual
 * resources because they have no visibility into sibling resources. When
 * the resource is part of an assignee.ai compound pattern that already
 * provides the sibling, the BP's concern is structurally satisfied by
 * the pattern and must be suppressed — otherwise apply-mode hits a
 * blocking finding on every single companion resource and the compound
 * loop can never make progress.
 *
 * Keep this allowlist narrow and explicit: only patterns that GUARANTEE
 * the structural requirement should suppress the BP.
 *
 * Wave-6c F3: extracted from bp-evaluator.ts (SRP/OCP — add a new pattern
 * by adding an entry; no code change elsewhere).
 */

import type { BPFinding } from "@assignee/best-practices";

export const COMPOUND_SUPPRESSIONS: Record<string, Set<string>> = {
  "vpc-networking": new Set([
    "BP-IGW-001",
    "BP-IGW-002",
    "BP-RT-001",
    "BP-RT-002",
    "BP-NAT-003",
  ]),
  "vpc-public-only": new Set(["BP-IGW-001", "BP-IGW-002", "BP-RT-002"]),
  "container-service": new Set([
    "BP-IGW-001",
    "BP-IGW-002",
    "BP-RT-001",
    "BP-RT-002",
  ]),
  "three-tier-web": new Set([
    "BP-IGW-001",
    "BP-IGW-002",
    "BP-RT-001",
    "BP-RT-002",
  ]),
};

export interface SuppressionResult {
  findings: BPFinding[];
  suppressedCount: number;
}

/** Apply pattern-aware suppression. Returns filtered findings + count. */
export function suppressCompoundFindings(
  findings: BPFinding[],
  patternId: string | undefined,
): SuppressionResult {
  if (!patternId || !COMPOUND_SUPPRESSIONS[patternId]) {
    return { findings, suppressedCount: 0 };
  }
  const suppressed = COMPOUND_SUPPRESSIONS[patternId]!;
  let suppressedCount = 0;
  const filtered = findings.filter((f) => {
    if (suppressed.has(f.practiceId)) {
      suppressedCount += 1;
      return false;
    }
    return true;
  });
  return { findings: filtered, suppressedCount };
}

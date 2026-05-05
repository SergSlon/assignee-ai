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
 *
 * SSH-bundle (Story i — 2026-05): the singleton EC2 SSH-intent path has
 * NO `resourcePattern` (it's a single resource, not a multi-resource
 * compound). To suppress BP-EC2-004 ("EC2 instance should have IAM
 * instance profile attached") on the SSH-bundle path, we introduce a
 * sibling `INTENT_BASED_SUPPRESSIONS` array keyed on the user's intent
 * regex AND a guard that requires the desiredState key to be populated
 * (defends against the SSH-IAM pre-hook silently failing — if the
 * profile isn't actually attached, the BP MUST still fire).
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

/**
 * Intent-based suppression entry. Each entry suppresses `suppressIds`
 * iff:
 *   1. `userIntent` matches `intentRegex` (case-insensitive at the entry's
 *      discretion — entries declare their own flags).
 *   2. `desiredState[mustHaveDesiredKey]` is non-empty (string OR object
 *      with `Arn`/`Name`).
 *
 * The desired-state guard is mandatory: it ensures we ONLY suppress when
 * the bundle actually attached the resource. If the auto-attach path
 * silently failed, the BP must still fire so the user is alerted.
 */
export interface IntentBasedSuppression {
  intentRegex: RegExp;
  mustHaveDesiredKey: string;
  suppressIds: string[];
}

export const INTENT_BASED_SUPPRESSIONS: ReadonlyArray<IntentBasedSuppression> =
  [
    {
      // SSH-bundle: when the user said "ssh" AND the SSH-IAM pre-hook
      // populated IamInstanceProfile, BP-EC2-004 ("attach IAM instance
      // profile") is structurally satisfied by the bundle.
      intentRegex: /\bssh\b/i,
      mustHaveDesiredKey: "IamInstanceProfile",
      suppressIds: ["BP-EC2-004"],
    },
  ];

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

/**
 * Truthy when the desiredState carries an actually-populated value at
 * `key`. String values must be non-empty after trim; object values are
 * accepted when they have an `Arn` or `Name` string field (CCAPI's
 * acceptable shapes for IamInstanceProfile).
 */
function hasPopulatedDesiredKey(
  desiredState: Record<string, unknown> | undefined,
  key: string,
): boolean {
  if (!desiredState) return false;
  const v = desiredState[key];
  if (typeof v === "string") return v.trim().length > 0;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o["Arn"] === "string" && o["Arn"].trim().length > 0) return true;
    if (typeof o["Name"] === "string" && o["Name"].trim().length > 0)
      return true;
  }
  return false;
}

/**
 * Apply intent-based suppression. Runs AFTER `suppressCompoundFindings`
 * (the patternId path) — entries here gate on `userIntent` + a populated
 * `desiredState` key, NOT on a known compound patternId. Returns the
 * filtered findings + the new-this-call suppressedCount (callers who
 * need a grand-total combine the two counts themselves).
 */
export function suppressIntentFindings(
  findings: BPFinding[],
  userIntent: string | undefined,
  desiredState: Record<string, unknown> | undefined,
): SuppressionResult {
  if (!userIntent || userIntent.length === 0) {
    return { findings, suppressedCount: 0 };
  }
  // Build the union of suppressed practice IDs from every matching entry.
  const suppressed = new Set<string>();
  for (const entry of INTENT_BASED_SUPPRESSIONS) {
    if (!entry.intentRegex.test(userIntent)) continue;
    if (!hasPopulatedDesiredKey(desiredState, entry.mustHaveDesiredKey))
      continue;
    for (const id of entry.suppressIds) suppressed.add(id);
  }
  if (suppressed.size === 0) return { findings, suppressedCount: 0 };

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

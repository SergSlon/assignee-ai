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
 * regex.
 *
 * Pre-demo audit (2026-05-05): the original design also gated the
 * suppression on `desiredState[IamInstanceProfile]` being populated
 * (defence against the SSH-IAM pre-hook silently failing). That guard
 * was load-bearing only if BP evaluation re-ran AFTER the pre-hook —
 * but `bp_evaluator` runs at PLAN time (Phase 1) and `ensureSshIamProfile`
 * runs at APPLY time (Phase 2, see `resource-provisioner.ts`). The
 * pre-hook never gets a chance to populate `desiredState` before the
 * suppressor reads it, so the guard ALWAYS failed → BP-EC2-004 always
 * fired in the plan box for "Create EC2 with SSH" intents, undermining
 * the bundle's UX promise. The guard is now optional (per-entry
 * `mustHaveDesiredKey` field); the SSH-bundle entry omits it because
 * the intent itself is sufficient evidence the bundle WILL satisfy
 * BP-EC2-004 at apply time. If a future entry needs the guard back,
 * set `mustHaveDesiredKey` and the original semantics return.
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
 *   2. (Optional) `desiredState[mustHaveDesiredKey]` is non-empty (string
 *      OR object with `Arn`/`Name`).
 *
 * The desired-state guard is OPTIONAL — entries that need to defer
 * suppression until a sibling pre-hook has populated the slot include
 * `mustHaveDesiredKey`; entries whose pre-hook runs in a later phase
 * (so the guard would always fail at suppressor-eval time) omit it. See
 * the SSH-bundle entry below for the canonical apply-time-pre-hook case.
 */
export interface IntentBasedSuppression {
  intentRegex: RegExp;
  /**
   * When set, the desired-state slot at this key must be non-empty for
   * the suppression to apply. Omit when the pre-hook that populates the
   * slot runs AFTER `bp_evaluator` (Phase-2 apply hooks) — at plan time
   * the slot is structurally empty so the guard would always fail.
   */
  mustHaveDesiredKey?: string;
  suppressIds: string[];
}

export const INTENT_BASED_SUPPRESSIONS: ReadonlyArray<IntentBasedSuppression> =
  [
    {
      // SSH-bundle: when the user said "ssh", BP-EC2-004 ("attach IAM
      // instance profile") is structurally satisfied by the bundle's
      // `ensureSshIamProfile` Phase-2 pre-hook (`resource-provisioner/
      // ssh-iam.ts`). No `mustHaveDesiredKey` because the pre-hook runs
      // at apply time AFTER bp_evaluator already evaluated — gating on
      // `desiredState.IamInstanceProfile` would always fail at plan-eval
      // time and the BP would fire in the plan box despite the bundle
      // being about to satisfy it.
      intentRegex: /\bssh\b/i,
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
    // The desired-state guard is OPTIONAL — entries omit it when the
    // pre-hook that populates the slot runs AFTER bp_evaluator (Phase-2
    // apply hooks). See the SSH-bundle entry in INTENT_BASED_SUPPRESSIONS.
    if (
      entry.mustHaveDesiredKey !== undefined &&
      !hasPopulatedDesiredKey(desiredState, entry.mustHaveDesiredKey)
    ) {
      continue;
    }
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

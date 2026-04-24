/**
 * IAM / resource policy anti-pattern inspector.
 *
 * Shared helper behind the `policy_antipattern` check type used by
 * Tier 1 (IAM policy document) and Tier 3 (S3 / SQS / SNS resource
 * policy) rules from `docs/bp-cfn-guard-gap-analysis-2026-04-08.md`.
 *
 * **Context.** Our BP rules historically inspect a single field via
 * `property_path` + `check_type`. IAM / resource-policy anti-patterns
 * don't fit that shape — they require walking the `Statement[]` array
 * of a policy document and looking for one of six semantic patterns
 * that the AWS Guard Rules Registry catalogues. Rather than author 16
 * bespoke rules, each rule just sets:
 *
 *     check_type: "policy_antipattern"
 *     expected_value: "wildcard-resource"
 *     property_path: "PolicyDocument"
 *
 * …and this module runs the actual structural walk.
 *
 * **Why all six patterns live together.** They share the same walker
 * (iterate `Statement[]`, skip `Effect: Deny`, inspect the named
 * property). Splitting into six modules would be an over-abstraction;
 * one file + one dispatch table is the right size.
 *
 * **Not** a general-purpose IAM analyzer. We only catch the six
 * patterns the Guard rules registry catalogues as "never legitimate".
 * Subtler policy-path analysis (e.g. condition-guarded wildcards,
 * SCPs, ABAC tag conditions) is out of scope — that's a runtime-only
 * concern and belongs on the live AWS account, not the plan.
 *
 * **Epic 99 W3e — PolicyContext discriminator.** `inspectPolicyDocument`
 * now accepts an optional `policyContext` parameter (see
 * `evaluate/policy-context.ts`). Context-sensitive predicates (e.g.
 * `cross-account-no-external-id`) gate on the document kind; patterns
 * that are document-kind-agnostic ignore the context.
 */

import type { PolicyContext } from "./evaluate/policy-context.js";

/* ------------------------------------------------------------------ */
/*  Pattern catalogue                                                  */
/* ------------------------------------------------------------------ */

/**
 * The six anti-patterns we recognise. Each corresponds directly to one
 * or more rules in `github.com/aws-cloudformation/aws-guard-rules-registry`,
 * documented in `docs/bp-cfn-guard-gap-analysis-2026-04-08.md`.
 */
export const POLICY_ANTIPATTERNS = [
  /** `Resource: "*"` or `Resource: ["*"]` on an Allow statement. */
  "wildcard-resource",
  /** `Action: "*"` or `Action: ["*"]` on an Allow statement. */
  "wildcard-action",
  /** `Principal: "*"` or `Principal: { AWS: "*" }` on an Allow statement. */
  "wildcard-principal",
  /**
   * Stricter sibling of `wildcard-principal`: fires only when the
   * statement has a wildcard Principal AND no `Condition` clause.
   * Epic 98 W4.B2 — BP-SNS-004 narrowing. A condition-guarded wildcard
   * (e.g. `Principal: "*"` + `Condition: { StringEquals: { aws:SourceAccount: "..." } }`)
   * is the canonical cross-account / cross-service trust shape, so the
   * plain `wildcard-principal` check would false-positive on it. This
   * variant treats an absent/null/empty-object `Condition` as the
   * "actually public" signal — keeping the rule CRITICAL while
   * eliminating the trust-erosion class the awareness-always-fire
   * baseline produced.
   */
  "wildcard-principal-no-condition",
  /** `Allow` + `NotAction` — the "deny all but X" silent-privilege trap. */
  "allow-plus-not-action",
  /** `Allow` + `NotResource` — same inversion on resources. */
  "allow-plus-not-resource",
  /** `Allow` + `NotPrincipal` (trust policies) — catastrophic on any role with real permissions. */
  "allow-plus-not-principal",
  /** `iam:PassRole` with `Resource: "*"` — direct privilege-escalation vector. */
  "passrole-wildcard-resource",
  /**
   * Cross-account `sts:AssumeRole` trust without an `sts:ExternalId`
   * Condition. Epic 98 W4.B5 — BP-IAM-010 closure. Fires on an Allow
   * statement in an `AssumeRolePolicyDocument` where:
   *   - `Action` covers `sts:AssumeRole` (or a wildcard that covers it), AND
   *   - `Principal.AWS` is an IAM user/role ARN (arn:aws:iam::<acct>:...)
   *     or an account-root wildcard (`arn:aws:iam::<acct>:root`), AND
   *   - no `Condition.StringEquals["sts:ExternalId"]` (or StringLike)
   *     narrows the trust.
   *
   * Guards against the canonical confused-deputy attack: a malicious
   * tenant in the trusted account induces your role-holder to assume
   * the role on their behalf. The External ID is the shared secret
   * that breaks that chain — without it, any principal in the trusted
   * account can assume the role.
   *
   * Service-principal trusts (`Principal.Service: "lambda.amazonaws.com"`)
   * do not fire — those are intra-service and the ExternalId pattern
   * doesn't apply. Wildcard Principals (`"*"`, `{AWS:"*"}`) are
   * flagged by `wildcard-principal` / `wildcard-principal-no-condition`
   * already; this rule complements them by catching the narrower
   * ARN-based cross-account shape that those patterns miss.
   */
  "cross-account-no-external-id",
  /**
   * ABSENCE check (inverse semantics): fires when the BucketPolicy
   * document does NOT contain a statement that denies non-SSL access.
   * Epic 98 W4.B4 — BP-S3-011 SSL-only closure.
   *
   * The canonical FSBP S3.5 mitigation is a Deny statement shaped like:
   *   { Effect: "Deny", Principal: "*", Action: "s3:*",
   *     Resource: [<bucket>, <bucket>/*],
   *     Condition: { Bool: { "aws:SecureTransport": "false" } } }
   *
   * This antipattern matches if NO statement satisfies that shape.
   * Unlike the other presence-based antipatterns, `matched: true`
   * here means "the required Deny is missing" (which still means
   * the rule-runner's `!matched` invert logic fires the finding
   * correctly — absence of the good statement IS the bad signal).
   *
   * Unique among the catalogue in that it checks for the absence of
   * a desired statement rather than the presence of a bad one.
   * Uses a dedicated absence-check branch in `inspectPolicyDocument`.
   */
  "missing-secure-transport-deny",
] as const;

export type PolicyAntipattern = (typeof POLICY_ANTIPATTERNS)[number];

/* ------------------------------------------------------------------ */
/*  Shape of a CloudFormation policy document                          */
/* ------------------------------------------------------------------ */

/**
 * Minimal structural type for a CloudFormation-encoded IAM policy
 * document. Real policies have more fields (`Version`, `Id`, `Sid`,
 * `Condition`, etc.) that we don't touch.
 */
interface PolicyStatement {
  Effect?: unknown;
  Action?: unknown;
  NotAction?: unknown;
  Resource?: unknown;
  NotResource?: unknown;
  Principal?: unknown;
  NotPrincipal?: unknown;
  /** Policies can carry arbitrary extra fields (Sid, Condition, …) we ignore. */
  [key: string]: unknown;
}

interface PolicyDocument {
  Version?: unknown;
  Statement?: unknown;
  [key: string]: unknown;
}

/* ------------------------------------------------------------------ */
/*  Result type                                                         */
/* ------------------------------------------------------------------ */

export interface PolicyInspectionResult {
  /** True when the anti-pattern was found somewhere in the document. */
  matched: boolean;
  /**
   * Index of the first `Statement[]` element that matched. `undefined`
   * when `matched` is false or the document is shaped wrong (null,
   * missing Statement, etc.) — the rule should treat shape issues as
   * "cannot evaluate", not "fail", to avoid noise during generation.
   */
  offendingStatementIndex?: number;
}

/* ------------------------------------------------------------------ */
/*  Small helpers                                                       */
/* ------------------------------------------------------------------ */

/**
 * Normalise a field that can be either a single string or an array of
 * strings into an array. `undefined`/`null`/other shapes → empty array.
 * Real-world policies use both forms interchangeably — the CloudFormation
 * intrinsic-function path can even return objects, but we only treat
 * plain strings as checkable. Objects (e.g. `Fn::Sub` results) are
 * opaque and we don't judge them.
 */
function toStringArray(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const item of value) {
      if (typeof item === "string") out.push(item);
    }
    return out;
  }
  return [];
}

/** True when any string in the array is literally `"*"`. */
function containsStarLiteral(values: string[]): boolean {
  return values.some((v) => v === "*");
}

/**
 * The Principal field has three valid shapes:
 *   - `"*"` (string)                     ← wildcard
 *   - `["*", "arn:aws:iam::..."]`        ← wildcard if any element is "*"
 *   - `{ AWS: "*" }` / `{ Service: … }`  ← wildcard if the AWS key is "*" or ["*"]
 * Everything else (specific ARNs, service principals, federated IDs)
 * is fine.
 */
function principalIsWildcard(principal: unknown): boolean {
  if (principal === "*") return true;
  if (Array.isArray(principal)) {
    return principal.some((p) => p === "*");
  }
  if (principal !== null && typeof principal === "object") {
    const awsKey = (principal as Record<string, unknown>)["AWS"];
    if (awsKey === "*") return true;
    if (Array.isArray(awsKey) && awsKey.some((v) => v === "*")) return true;
  }
  return false;
}

/**
 * IAM ARN shape: `arn:aws:iam::<12-digit-account>:<entity>`. Used by
 * the cross-account-no-external-id check to identify principals that
 * could be in another AWS account. Partition-agnostic (`arn:aws-us-gov`,
 * `arn:aws-cn`) so GovCloud and China trust policies are covered.
 */
const IAM_ARN_RE = /^arn:aws[\w-]*:iam::\d{12}:/;

/**
 * True when the Principal field references at least one IAM entity
 * by ARN (user, role, or account-root). Shapes handled:
 *   - `"arn:aws:iam::<acct>:root"` (string)
 *   - `["arn:aws:iam::<acct>:role/X", "arn:..."]` (array of strings)
 *   - `{ AWS: "arn:aws:iam::<acct>:root" }` (object form, single ARN)
 *   - `{ AWS: ["arn:aws:iam::<acct>:role/X", "arn:..."] }` (object, array)
 *
 * Returns false for wildcard Principals (covered by sibling checks),
 * Service principals, Federated principals, and absent Principals.
 */
function principalHasIamArn(principal: unknown): boolean {
  if (typeof principal === "string") return IAM_ARN_RE.test(principal);
  if (Array.isArray(principal)) {
    return principal.some((p) => typeof p === "string" && IAM_ARN_RE.test(p));
  }
  if (principal !== null && typeof principal === "object") {
    const awsKey = (principal as Record<string, unknown>)["AWS"];
    if (typeof awsKey === "string") return IAM_ARN_RE.test(awsKey);
    if (Array.isArray(awsKey)) {
      return awsKey.some((v) => typeof v === "string" && IAM_ARN_RE.test(v));
    }
  }
  return false;
}

/**
 * True when the given Condition object contains a narrowing clause
 * keyed on `sts:ExternalId`. Tolerates:
 *   - `StringEquals` (canonical)
 *   - `StringLike`  (accepted — operators sometimes use this for
 *     prefix/wildcard ExternalId generation)
 *   - `StringEqualsIgnoreCase`
 * Under any of those, the value must be a non-empty string or a
 * non-empty array of strings. Empty strings or empty arrays count as
 * "no narrow" so a stub condition doesn't silently disarm the rule.
 */
function hasExternalIdCondition(condition: unknown): boolean {
  if (condition === null || typeof condition !== "object") return false;
  if (Array.isArray(condition)) return false;
  const cond = condition as Record<string, unknown>;
  const operators = ["StringEquals", "StringLike", "StringEqualsIgnoreCase"];
  for (const op of operators) {
    const opBlock = cond[op];
    if (opBlock === null || typeof opBlock !== "object") continue;
    if (Array.isArray(opBlock)) continue;
    const externalId = (opBlock as Record<string, unknown>)["sts:ExternalId"];
    if (typeof externalId === "string" && externalId.length > 0) return true;
    if (Array.isArray(externalId)) {
      if (externalId.some((v) => typeof v === "string" && v.length > 0)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Return the `Statement[]` array from a document, normalising the two
 * legal forms: a single statement object or an array. Returns `null`
 * (distinct from an empty array) when the input isn't a plausible
 * policy document so callers can short-circuit with `matched: false`.
 */
function extractStatements(doc: unknown): PolicyStatement[] | null {
  if (doc === null || typeof doc !== "object") return null;
  const policy = doc as PolicyDocument;
  const stmt = policy.Statement;
  if (stmt === undefined || stmt === null) return null;
  if (Array.isArray(stmt)) {
    // Filter non-object entries out — they're malformed and we don't
    // want to mistake them for "no finding".
    return stmt.filter(
      (s): s is PolicyStatement => s !== null && typeof s === "object",
    );
  }
  if (typeof stmt === "object") {
    return [stmt as PolicyStatement];
  }
  return null;
}

/**
 * Minimum-viable Condition keys that meaningfully scope a wildcard
 * Principal statement. A Condition that contains at least one of these
 * keys — with a non-wildcard value — is treated as a legitimate scoping
 * mechanism and suppresses the `wildcard-principal-no-condition` finding.
 *
 * Keys are stored in lower-case; comparison is case-insensitive so that
 * YAML authors who capitalise keys differently still pass the check.
 *
 * Epic 99 W3e (W-019 / CT-7) — replaces the plain `Object.keys().length === 0`
 * check which treated ANY non-empty Condition (even trivially-permissive
 * ones like `{ StringLike: { "aws:SourceAccount": "*" } }`) as scoping.
 */
const MEANINGFUL_CONDITION_KEYS = new Set([
  "aws:sourceaccount",
  "aws:sourcearn",
  "aws:principalorgid",
  "aws:principalaccount",
  "aws:principalarn",
  "aws:sourceorgid",
  "aws:sourcevpce",
  "aws:sourcevpc",
  "kms:calleraccount",
]);

/**
 * Return true when the given Condition object contains at least one
 * key from `MEANINGFUL_CONDITION_KEYS` whose value is NOT a bare
 * wildcard (`"*"` or an array whose only element is `"*"`).
 *
 * Two-level walk: Condition → { <Operator>: { <ConditionKey>: <value> } }
 * We walk every operator block and every condition key within it.
 *
 * Rules:
 *   1. The condition key (lowercased) must be in MEANINGFUL_CONDITION_KEYS.
 *   2. The value under that key must not be the bare wildcard `"*"`.
 *      - String `"*"` → wildcard (no meaningful scoping).
 *      - Array `["*"]` → wildcard.
 *      - Array `["*", "something"]` → mixed; the non-wildcard element
 *        still constitutes scoping → meaningful (conservative).
 *      - Anything else (specific account, ARN, OrgID, etc.) → meaningful.
 *
 * Returns false for null / non-object Condition shapes — those are
 * treated the same as absent (no scoping).
 */
function hasMeaningfulConditionKey(condition: unknown): boolean {
  if (condition === null || typeof condition !== "object") return false;
  if (Array.isArray(condition)) return false;
  const condObj = condition as Record<string, unknown>;
  for (const opBlock of Object.values(condObj)) {
    if (opBlock === null || typeof opBlock !== "object") continue;
    if (Array.isArray(opBlock)) continue;
    const opObj = opBlock as Record<string, unknown>;
    for (const [rawKey, rawValue] of Object.entries(opObj)) {
      if (!MEANINGFUL_CONDITION_KEYS.has(rawKey.toLowerCase())) continue;
      // Key is in the allowlist — check that the value is not a bare wildcard.
      if (typeof rawValue === "string") {
        // A pure "*" value provides no scoping.
        if (rawValue === "*") continue;
        return true;
      }
      if (Array.isArray(rawValue)) {
        // An array that consists ONLY of "*" provides no scoping.
        // If there's at least one non-"*" element, it does scope.
        const hasNonWildcard = rawValue.some(
          (v) => typeof v === "string" && v !== "*",
        );
        if (hasNonWildcard) return true;
        continue;
      }
      // Non-string, non-array value (object, number, boolean) — treat as meaningful.
      return true;
    }
  }
  return false;
}

/** `Effect` is only an anti-pattern trigger when it's "Allow". */
function isAllow(stmt: PolicyStatement): boolean {
  // Absent Effect is treated as Allow per IAM default semantics —
  // CloudFormation allows Effect to be omitted and IAM interprets
  // missing as Allow. We don't get to assume "Deny" fallback.
  return stmt.Effect === undefined || stmt.Effect === "Allow";
}

/* ------------------------------------------------------------------ */
/*  Per-pattern checks                                                  */
/* ------------------------------------------------------------------ */

/** Shape of a per-pattern check — returns true when the statement matches. */
type StatementCheck = (stmt: PolicyStatement) => boolean;

const CHECKS: Record<PolicyAntipattern, StatementCheck> = {
  "wildcard-resource": (stmt) => {
    if (!isAllow(stmt)) return false;
    return containsStarLiteral(toStringArray(stmt.Resource));
  },

  "wildcard-action": (stmt) => {
    if (!isAllow(stmt)) return false;
    return containsStarLiteral(toStringArray(stmt.Action));
  },

  "wildcard-principal": (stmt) => {
    if (!isAllow(stmt)) return false;
    return principalIsWildcard(stmt.Principal);
  },

  "wildcard-principal-no-condition": (stmt) => {
    // Epic 98 W4.B2 — BP-SNS-004 closure. Fires only when the Allow
    // statement carries a wildcard Principal AND has no meaningful
    // Condition clause. Condition-guarded wildcards are the canonical
    // cross-account / CloudFront-OAI / S3-Bucket-public-OAC trust
    // shape and must NOT fire — the plain `wildcard-principal` check
    // already covers the no-nuance "anything public" signal.
    //
    // Epic 99 W3e (W-019 / CT-7) — replaces the plain
    // `Object.keys().length === 0` check. A non-empty Condition is no
    // longer sufficient to suppress; the Condition must contain at
    // least one key from MEANINGFUL_CONDITION_KEYS with a non-wildcard
    // value. This closes the CT-7 loophole where a trivially permissive
    // `Condition: { StringLike: { "aws:SourceAccount": "*" } }` would
    // disarm CRITICAL findings for BP-SNS-004 + BP-IAM-010.
    //
    // Suppression rules:
    //   • Absent / null Condition                      → fires (no guard)
    //   • Non-object Condition                         → fires (malformed)
    //   • Empty-object Condition {}                    → fires (no guard)
    //   • Condition with a meaningful key + non-wildcard value → suppresses
    //   • Condition with only meaningless keys          → fires
    //   • Condition with a meaningful key but value "*" → fires
    if (!isAllow(stmt)) return false;
    if (!principalIsWildcard(stmt.Principal)) return false;
    const condition = stmt["Condition"];
    if (condition === undefined || condition === null) return true;
    if (typeof condition !== "object") return true;
    if (Array.isArray(condition) && condition.length === 0) return true;
    // hasMeaningfulConditionKey handles empty-object {} and all other shapes.
    return !hasMeaningfulConditionKey(condition);
  },

  "allow-plus-not-action": (stmt) => {
    if (!isAllow(stmt)) return false;
    // NotAction only has meaning on Allow statements. Presence is the
    // anti-pattern — we don't need to inspect what's inside.
    return stmt.NotAction !== undefined;
  },

  "allow-plus-not-resource": (stmt) => {
    if (!isAllow(stmt)) return false;
    return stmt.NotResource !== undefined;
  },

  "allow-plus-not-principal": (stmt) => {
    if (!isAllow(stmt)) return false;
    return stmt.NotPrincipal !== undefined;
  },

  "passrole-wildcard-resource": (stmt) => {
    if (!isAllow(stmt)) return false;
    // Only flag if the statement includes iam:PassRole (or wildcard
    // that covers it) AND the Resource is "*".
    const actions = toStringArray(stmt.Action);
    const grantsPassRole = actions.some(
      (a) =>
        a === "iam:PassRole" ||
        a === "iam:*" ||
        a === "*" ||
        // Covers "iam:Pass*" and similar prefixes.
        /^iam:Pass[^:]*$/i.test(a),
    );
    if (!grantsPassRole) return false;
    return containsStarLiteral(toStringArray(stmt.Resource));
  },

  "cross-account-no-external-id": (stmt) => {
    // Epic 98 W4.B5 — BP-IAM-010 closure. Fires on an Allow statement
    // in a trust policy where a cross-account AWS principal can assume
    // the role without an sts:ExternalId guard. Shape:
    //   Action covers sts:AssumeRole AND
    //   Principal.AWS is an IAM ARN (arn:aws:iam::<acct>:...) AND
    //   Condition has no sts:ExternalId narrow.
    // Service-principal trusts (lambda.amazonaws.com etc.) are out of
    // scope — those aren't vulnerable to the confused-deputy pattern.
    if (!isAllow(stmt)) return false;
    const actions = toStringArray(stmt.Action);
    const grantsAssumeRole = actions.some(
      (a) => a === "sts:AssumeRole" || a === "sts:*" || a === "*",
    );
    if (!grantsAssumeRole) return false;
    if (!principalHasIamArn(stmt.Principal)) return false;
    // Already-wildcard Principals are flagged by sibling checks — let
    // those own the finding and avoid double-firing here.
    if (principalIsWildcard(stmt.Principal)) return false;
    return !hasExternalIdCondition(stmt["Condition"]);
  },

  // Epic 98 W4.B4 — absence check dispatched separately below.
  // This entry lives in CHECKS so the exhaustiveness assertion
  // (`every PolicyAntipattern has a CHECKS entry`) still passes;
  // the per-statement predicate intentionally never matches —
  // the real logic lives in `satisfiesSecureTransportDeny` +
  // the absence branch in `inspectPolicyDocument`.
  "missing-secure-transport-deny": (_stmt) => false,
};

/* ------------------------------------------------------------------ */
/*  Desired-statement helpers (absence checks)                          */
/* ------------------------------------------------------------------ */

/**
 * True when the given statement is a canonical "deny non-SSL access"
 * clause. Tolerates the three legal forms the Condition values take:
 *   - `"false"`                 ← FSBP doc string form
 *   - `false`                   ← CloudFormation sometimes emits bool
 *   - `["false"]` / `[false]`   ← array-of-values form
 *
 * Action must cover S3 actions (`"s3:*"`, `["s3:*"]`, or `"*"`).
 * Principal must be wildcard (`"*"` or `{AWS:"*"}`) — the Deny is
 * meant to apply to every caller.
 *
 * Does NOT validate Resource shape: operators routinely scope the
 * Deny to the bucket + bucket/* ARNs, but the YAML-author pattern
 * we want to encourage allows either a specific pair or `"*"`. A
 * stricter Resource check would reject legitimate configurations.
 */
function satisfiesSecureTransportDeny(stmt: PolicyStatement): boolean {
  if (stmt.Effect !== "Deny") return false;
  // Principal check — wildcard only. A Deny against a specific
  // principal doesn't protect the bucket from other callers.
  if (!principalIsWildcard(stmt.Principal)) return false;
  // Action must cover S3.
  const actions = toStringArray(stmt.Action);
  const coversS3 = actions.some(
    (a) => a === "s3:*" || a === "*" || /^s3:[A-Za-z*]+$/.test(a),
  );
  if (!coversS3) return false;
  // Condition.Bool["aws:SecureTransport"] must be the false signal.
  const condition = stmt["Condition"];
  if (condition === null || typeof condition !== "object") return false;
  if (Array.isArray(condition)) return false;
  const boolCond = (condition as Record<string, unknown>)["Bool"];
  if (boolCond === null || typeof boolCond !== "object") return false;
  if (Array.isArray(boolCond)) return false;
  const secureTransport = (boolCond as Record<string, unknown>)[
    "aws:SecureTransport"
  ];
  return (
    secureTransport === "false" ||
    secureTransport === false ||
    (Array.isArray(secureTransport) &&
      secureTransport.some((v) => v === "false" || v === false))
  );
}

/**
 * Registry of absence-check predicates. Each entry returns true when
 * the document is MISSING the desired statement — triggering the
 * rule-runner's `!matched` inversion to fire the finding.
 *
 * Separate from `CHECKS` because the semantics are inverted: here we
 * scan every statement looking for ONE that satisfies the required
 * shape, and fire the antipattern if none is found.
 */
const ABSENCE_CHECKS: Partial<
  Record<PolicyAntipattern, (stmt: PolicyStatement) => boolean>
> = {
  "missing-secure-transport-deny": satisfiesSecureTransportDeny,
};

/**
 * True when the given antipattern uses absence-check semantics (fires
 * when the desired statement is MISSING rather than when a bad pattern
 * is present). Exported so the rule-runner can short-circuit the
 * usual "missing fieldValue → rule passes" branch for these patterns:
 * a missing policy document IS the failure signal here.
 */
export function isAbsenceAntipattern(pattern: string): boolean {
  return pattern in ABSENCE_CHECKS;
}

/* ------------------------------------------------------------------ */
/*  Public entry point                                                  */
/* ------------------------------------------------------------------ */

/**
 * Walk a CloudFormation-encoded IAM / resource policy document and
 * check for the named anti-pattern. Pure function — no I/O, no async,
 * no mutation of the input.
 *
 * @param doc      The policy document as it appears in `desiredState`
 *                 (usually at a `.PolicyDocument` or `.AssumeRolePolicyDocument` path).
 * @param pattern  Which anti-pattern to check for.
 * @param context  Optional document-kind discriminator (see `evaluate/policy-context.ts`).
 *                 When provided, context-sensitive predicates gate on the document kind:
 *                 - `cross-account-no-external-id` only fires in `{ kind: "trust" }` context.
 *                 When omitted, each predicate applies its own default semantics.
 * @returns        `matched: true` with `offendingStatementIndex` when
 *                 the pattern is found; `matched: false` otherwise
 *                 (including when the document is malformed — callers
 *                 should treat "cannot evaluate" as "no finding" to
 *                 avoid noisy false positives during plan generation).
 */
export function inspectPolicyDocument(
  doc: unknown,
  pattern: PolicyAntipattern,
  context?: PolicyContext,
): PolicyInspectionResult {
  // Epic 99 W3e — context-sensitive gates. Patterns that only make sense
  // in a specific document kind return "not applicable" (matched: false)
  // when a different context is provided. This prevents spurious findings
  // when a rule is evaluated against a resource or identity policy that
  // happens to contain an sts:AssumeRole-like statement.
  if (pattern === "cross-account-no-external-id" && context !== undefined) {
    if (context.kind !== "trust") {
      // cross-account confused-deputy attack requires a trust policy.
      // Resource policies and identity policies that contain sts:AssumeRole
      // actions are not vulnerable to this pattern in the same way.
      return { matched: false };
    }
  }
  // Absence checks (Epic 98 W4.B4+) have inverted semantics — they
  // fire when the desired statement is MISSING, so a null/malformed
  // document or an empty Statement array ALSO counts as missing.
  // Route those patterns through the dedicated absence branch before
  // the presence-pattern short-circuit.
  const absenceCheck = ABSENCE_CHECKS[pattern];
  if (absenceCheck !== undefined) {
    const statements = extractStatements(doc);
    if (statements === null || statements.length === 0) {
      // No statements at all → desired Deny is definitely missing.
      // Note: a completely missing BucketPolicy (undefined fieldValue)
      // is handled at the rule-runner level, not here; this branch
      // covers the case where the BucketPolicy object exists but its
      // Statement array is empty or malformed.
      return { matched: true };
    }
    for (let i = 0; i < statements.length; i++) {
      if (absenceCheck(statements[i]!)) {
        // Desired statement found → antipattern does NOT match.
        return { matched: false };
      }
    }
    // Walked every statement and none satisfied the desired shape.
    return { matched: true };
  }

  const statements = extractStatements(doc);
  if (statements === null) return { matched: false };

  const check = CHECKS[pattern];
  // The dispatch table above is exhaustive over PolicyAntipattern, but
  // TypeScript can't prove that at runtime if a caller passes an
  // unknown string. Guard against it so we return a sane "no match"
  // rather than crashing.
  if (check === undefined) return { matched: false };

  for (let i = 0; i < statements.length; i++) {
    if (check(statements[i]!)) {
      return { matched: true, offendingStatementIndex: i };
    }
  }
  return { matched: false };
}

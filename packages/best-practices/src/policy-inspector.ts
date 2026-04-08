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
 */

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
  /** `Allow` + `NotAction` — the "deny all but X" silent-privilege trap. */
  "allow-plus-not-action",
  /** `Allow` + `NotResource` — same inversion on resources. */
  "allow-plus-not-resource",
  /** `Allow` + `NotPrincipal` (trust policies) — catastrophic on any role with real permissions. */
  "allow-plus-not-principal",
  /** `iam:PassRole` with `Resource: "*"` — direct privilege-escalation vector. */
  "passrole-wildcard-resource",
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
};

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
 * @returns        `matched: true` with `offendingStatementIndex` when
 *                 the pattern is found; `matched: false` otherwise
 *                 (including when the document is malformed — callers
 *                 should treat "cannot evaluate" as "no finding" to
 *                 avoid noisy false positives during plan generation).
 */
export function inspectPolicyDocument(
  doc: unknown,
  pattern: PolicyAntipattern,
): PolicyInspectionResult {
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

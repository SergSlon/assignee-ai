export const BP_SEVERITY = ["CRITICAL", "HIGH", "MEDIUM", "INFO"] as const;
export type BPSeverity = (typeof BP_SEVERITY)[number];

/** Named severity level constants to eliminate magic strings in comparisons. */
export const Severity = {
  CRITICAL: "CRITICAL" as const,
  HIGH: "HIGH" as const,
  MEDIUM: "MEDIUM" as const,
  INFO: "INFO" as const,
};

export const BP_CATEGORY = [
  "security",
  "cost",
  "reliability",
  "performance",
  "compliance",
] as const;
export type BPCategory = (typeof BP_CATEGORY)[number];

export const BP_CHECK_TYPE = [
  "equals",
  "not_equals",
  "exists",
  "not_exists",
  "greater_than",
  "less_than",
  "contains",
  "not_contains",
  "conditional_forbidden",
  "cross_resource_count",
  "cross_resource_reference",
  "awareness",
  /**
   * Inspect an IAM / resource policy document (at the rule's
   * property_path) for one of the anti-patterns catalogued in
   * `policy-inspector.ts`. The `expected_value` field carries the
   * antipattern name ("wildcard-resource", "allow-plus-not-action",
   * etc.). Rule fails when the pattern is found in any Allow
   * statement; passes otherwise (including malformed documents,
   * which we silently skip to avoid plan-time noise).
   *
   * @see docs/bp-cfn-guard-gap-analysis-2026-04-08.md
   */
  "policy_antipattern",
  /**
   * Pattern-based variant of `not_contains`: the `expected_value` is
   * treated as a JavaScript regex source string and tested against
   * either the string `fieldValue` or — when `fieldValue` is an array
   * — every element in turn. The rule PASSES when no element matches
   * the pattern; FAILS (finding fires) when at least one does.
   *
   * Missing/null fieldValue trivially passes (nothing to match).
   *
   * Intended for array-of-strings fields where `not_contains` cannot
   * express the "any element matching X" shape — the canonical use
   * case is BP-IAM-017 (IAM role ManagedPolicyArns must not attach
   * AWS-managed policies whose ARN ends in `FullAccess` without
   * explicit review).
   *
   * @see A1 warmup — BP-IAM-017 elevated *FullAccess heuristic
   */
  "not_contains_pattern",
  /**
   * Security-group predicate: fires (rule fails) when `fieldValue`
   * (expected to be a `SecurityGroupIngress` array) contains at least
   * one rule that opens the given CIDR to ANY port in a comma-
   * separated set of high-risk/admin/DB ports.
   *
   * `expected_value` grammar:
   *   "<cidr>:<port1>,<port2>,...,<portN>"
   * Example:
   *   "0.0.0.0/0:20,21,1433,1434,1521,3306,3389,4333,5432,5439,5500,6379,9200,27017"
   *
   * Semantics mirror the single-port CIDR:port grammar used by the
   * `not_equals` branch (BP-SG-002, BP-SG-005): range rules that
   * cover any port in the set fire, all-traffic rules (IpProtocol: -1,
   * no port bounds) fire, non-matching CIDRs do not fire.
   *
   * Used by BP-SG-004 (renamed from the legacy BP-SG-007 slot) to
   * replace the `awareness`-tagged always-fire behaviour that
   * surfaced DB-focused copy on every SG plan (including safe port-
   * 443-only load balancers) — see Epic 96 W3.N2.
   */
  "sg_high_risk_public_exposure",
  /**
   * Predicate-based check over a nested array inside every element of
   * an outer array field. `property_path` resolves to the outer array
   * (e.g. `ContainerDefinitions`); `expected_value` carries a
   * JSONPath-like predicate of the shape
   *   "<innerArray>[?(@.<prop>=~/<regex>/<flags>)] does not exist"
   *
   * The rule FAILS (finding fires) when any inner-array element's
   * `<prop>` value matches the regex; PASSES when no match exists
   * across all outer elements.
   *
   * Canonical use case: BP-ECS-004 — detect secret-like identifiers
   * (PASSWORD, SECRET, API_KEY, TOKEN, CONNECTION_STRING…) declared
   * as plaintext ECS container Environment variables when they should
   * be referenced through the `Secrets` array. Before Epic 98 W4.B1
   * the rule was marked `awareness` and always fired, training users
   * to ignore CRITICAL severity on every ECS task definition.
   *
   * Defensive posture: malformed grammar or non-array field values
   * PASS silently — a YAML typo must never flood findings.
   *
   * @see packages/best-practices/src/evaluate/predicates/nested-array-predicate.ts
   */
  "nested_array_predicate",
] as const;
export type BPCheckType = (typeof BP_CHECK_TYPE)[number];

export interface Trigger {
  resourceType?: string;
  fieldCondition?: string;
  patternId?: string;
  intentKeywords?: string[];
  always?: boolean;
  /** When the EvalContext patternId matches any entry, suppress this rule entirely. */
  excludePatterns?: string[];
}

export const BP_FIX_TYPE = ["auto", "interactive", "info"] as const;
export type BPFixType = (typeof BP_FIX_TYPE)[number];

/** Named constants for BPFixType to eliminate magic strings in comparisons. */
export const FixType = {
  AUTO: "auto" as const,
  INTERACTIVE: "interactive" as const,
  INFO: "info" as const,
};

/** Named constants for InteractiveFixOption.action to eliminate magic strings. */
export const FixAction = {
  PROMPT_VALUE: "prompt_value" as const,
  SET_VALUE: "set_value" as const,
  REMOVE_PROPERTY: "remove_property" as const,
  SKIP: "skip" as const,
};

export interface InteractiveFixOption {
  label: string;
  action: "prompt_value" | "set_value" | "remove_property" | "skip";
  targetField?: string;
  targetValue?: unknown;
}

export interface BestPractice {
  id: string;
  title: string;
  severity: BPSeverity;
  resource_type: string;
  property_path: string;
  check_type: BPCheckType;
  expected_value: unknown;
  source: string;
  source_id?: string;
  description?: string;
  remediation?: string;
  category: BPCategory;
  version?: string;
  lastVerified: string;
  triggers?: Trigger[];
  autoFixable?: boolean;
  desiredStatePatch?: Record<string, unknown>;
  blocking?: boolean;
  fixType?: BPFixType;
  interactiveOptions?: InteractiveFixOption[];
  fix_hint?: string;
  /** Human-readable explanation of the risk if this practice is not followed. */
  consequence?: string;
}

export interface BPFinding {
  practiceId: string;
  title: string;
  severity: BPSeverity;
  category: BPCategory;
  message: string;
  remediation?: string;
  blocking: boolean;
  autoFixable?: boolean;
  desiredStatePatch?: Record<string, unknown>;
  fixType?: BPFixType;
  interactiveOptions?: InteractiveFixOption[];
  propertyPath?: string;
  fixHint?: string;
  /** Human-readable explanation of the risk if this practice is not followed. */
  consequence?: string;
  userSkipped?: boolean;
  userExplicitChoice?: boolean;
}

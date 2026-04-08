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
  "cost_optimization",
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

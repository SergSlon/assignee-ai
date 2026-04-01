export declare const BP_SEVERITY: readonly [
  "CRITICAL",
  "HIGH",
  "MEDIUM",
  "INFO",
];
export type BPSeverity = (typeof BP_SEVERITY)[number];
export declare const BP_CATEGORY: readonly [
  "security",
  "cost",
  "cost_optimization",
  "reliability",
  "performance",
  "compliance",
];
export type BPCategory = (typeof BP_CATEGORY)[number];
export declare const BP_CHECK_TYPE: readonly [
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
];
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
export declare const BP_FIX_TYPE: readonly ["auto", "interactive", "info"];
export type BPFixType = (typeof BP_FIX_TYPE)[number];
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
  userSkipped?: boolean;
  userExplicitChoice?: boolean;
}
//# sourceMappingURL=types.d.ts.map

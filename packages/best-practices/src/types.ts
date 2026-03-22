export const BP_SEVERITY = ["CRITICAL", "HIGH", "MEDIUM", "INFO"] as const;
export type BPSeverity = (typeof BP_SEVERITY)[number];

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
] as const;
export type BPCheckType = (typeof BP_CHECK_TYPE)[number];

export interface Trigger {
  resourceType?: string;
  fieldCondition?: string;
  patternId?: string;
  intentKeywords?: string[];
  always?: boolean;
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
}

export interface BPFinding {
  practiceId: string;
  title: string;
  severity: BPSeverity;
  category: BPCategory;
  message: string;
  remediation?: string;
}

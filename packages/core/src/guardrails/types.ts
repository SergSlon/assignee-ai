/**
 * Core types for the fast guardrail engine.
 * Guardrails are rule-based checks that run synchronously in <100ms
 * with zero I/O, zero async, and zero LLM calls.
 *
 * @see Story 10.4, architecture.md — Best Practices Library
 */

/** Severity of a guardrail finding. */
export type GuardrailSeverity = "pass" | "warning" | "critical";

/**
 * A single finding produced by a guardrail rule evaluation.
 * Returned by GuardrailRule.evaluate when a violation is detected.
 */
export interface GuardrailFinding {
  /** Unique identifier for the rule that produced this finding. */
  ruleId: string;
  /** Severity level of the finding. */
  severity: GuardrailSeverity;
  /** Human-readable description of the finding. */
  message: string;
  /** Optional field path that triggered the finding. */
  field?: string;
}

/**
 * A guardrail rule that evaluates a resource's desired state for misconfigurations.
 * Rules are pure functions — zero I/O, zero async, zero network calls.
 */
export interface GuardrailRule {
  /** Unique identifier for this rule. */
  ruleId: string;
  /** CloudFormation resource types this rule applies to. */
  resourceTypes: string[];
  /**
   * Evaluates the desired state for a resource of the given type.
   * Returns a GuardrailFinding if a violation is detected, or null if the check passes.
   *
   * @param resourceType - The CloudFormation resource type being evaluated
   * @param desiredState - The desired state configuration to check
   */
  evaluate: (
    resourceType: string,
    desiredState: Record<string, unknown>,
  ) => GuardrailFinding | null;
}

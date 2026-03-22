/**
 * GuardrailEngine — registry and evaluator for fast guardrail rules.
 * Follows the PricingStrategyRegistry pattern: Map-backed, pure function evaluation.
 *
 * @see Story 10.4, Task 3.1
 */

import type { GuardrailRule, GuardrailFinding } from "./types.js";

/**
 * Registry that holds guardrail rules and evaluates them against resource configs.
 * All evaluation is synchronous, pure, and must complete in <100ms.
 */
export class GuardrailEngine {
  private readonly rules: GuardrailRule[] = [];

  /** Registers a guardrail rule for evaluation. */
  register(rule: GuardrailRule): void {
    this.rules.push(rule);
  }

  /**
   * Evaluates all registered rules that match the given resource type.
   * Returns an array of findings (empty if all checks pass).
   *
   * @param resourceType - The CloudFormation resource type to evaluate
   * @param desiredState - The desired state configuration to check
   * @returns Array of GuardrailFinding objects for detected violations
   */
  evaluate(
    resourceType: string,
    desiredState: Record<string, unknown>,
  ): GuardrailFinding[] {
    const findings: GuardrailFinding[] = [];

    for (const rule of this.rules) {
      if (!rule.resourceTypes.includes(resourceType)) continue;
      const finding = rule.evaluate(resourceType, desiredState);
      if (finding) {
        findings.push(finding);
      }
    }

    return findings;
  }
}

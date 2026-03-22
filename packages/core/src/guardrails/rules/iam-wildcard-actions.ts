/**
 * Guardrail rule: IAM wildcard action/resource detection.
 * Checks for Action: ["*"] or Resource: ["*"] in IAM policy documents.
 * Starts with simple detection — does not parse full IAM policy language.
 *
 * @see Story 10.4, Task 2.4
 */

import type { GuardrailRule } from "../types.js";

/**
 * Checks whether a value or array contains a wildcard "*".
 * Handles both string and string[] formats.
 */
function containsWildcard(value: unknown): boolean {
  if (value === "*") return true;
  if (Array.isArray(value)) {
    return value.some((v) => v === "*");
  }
  return false;
}

/**
 * Recursively checks policy statements for wildcard actions or resources.
 * Handles both single statement objects and statement arrays.
 */
function checkStatements(statements: unknown): {
  wildcardAction: boolean;
  wildcardResource: boolean;
} {
  const result = { wildcardAction: false, wildcardResource: false };

  if (!statements) return result;

  const stmtArray = Array.isArray(statements) ? statements : [statements];

  for (const stmt of stmtArray) {
    if (typeof stmt !== "object" || stmt === null) continue;
    const s = stmt as Record<string, unknown>;

    if (containsWildcard(s["Action"])) {
      result.wildcardAction = true;
    }
    if (containsWildcard(s["Resource"])) {
      result.wildcardResource = true;
    }
  }

  return result;
}

/** Detects IAM policies with wildcard Action: * or Resource: *. */
export const iamWildcardActionsRule: GuardrailRule = {
  ruleId: "iam-wildcard-actions",
  resourceTypes: ["AWS::IAM::Role"],
  evaluate: (_resourceType: string, desiredState: Record<string, unknown>) => {
    // Check AssumeRolePolicyDocument
    const assumePolicy = desiredState["AssumeRolePolicyDocument"] as
      | Record<string, unknown>
      | undefined;

    // Check Policies array (inline policies)
    const policies = desiredState["Policies"] as
      | Array<Record<string, unknown>>
      | undefined;

    let wildcardAction = false;
    let wildcardResource = false;

    // Check assume role policy
    if (assumePolicy) {
      const result = checkStatements(assumePolicy["Statement"]);
      wildcardAction = wildcardAction || result.wildcardAction;
      wildcardResource = wildcardResource || result.wildcardResource;
    }

    // Check inline policies
    if (Array.isArray(policies)) {
      for (const policy of policies) {
        const policyDoc = policy["PolicyDocument"] as
          | Record<string, unknown>
          | undefined;
        if (policyDoc) {
          const result = checkStatements(policyDoc["Statement"]);
          wildcardAction = wildcardAction || result.wildcardAction;
          wildcardResource = wildcardResource || result.wildcardResource;
        }
      }
    }

    const issues: string[] = [];
    if (wildcardAction) issues.push("Action: *");
    if (wildcardResource) issues.push("Resource: *");

    if (issues.length > 0) {
      return {
        ruleId: "iam-wildcard-actions",
        severity: "critical",
        message: `IAM policy contains wildcard permissions (${issues.join(", ")})`,
        field: wildcardAction ? "AssumeRolePolicyDocument" : "Policies",
      };
    }

    return null;
  },
};

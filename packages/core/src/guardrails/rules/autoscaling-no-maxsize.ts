/**
 * Guardrail rule: Auto-scaling group without MaxSize.
 * Checks that auto-scaling groups have a MaxSize defined to prevent unbounded scaling.
 *
 * @see Story 10.4, Task 2.5
 */

import type { GuardrailRule } from "../types.js";

/** Detects auto-scaling groups defined without a MaxSize limit. */
export const autoscalingNoMaxSizeRule: GuardrailRule = {
  ruleId: "autoscaling-no-maxsize",
  resourceTypes: ["AWS::AutoScaling::AutoScalingGroup"],
  evaluate: (_resourceType: string, desiredState: Record<string, unknown>) => {
    const maxSize = desiredState["MaxSize"];

    if (maxSize === undefined || maxSize === null) {
      return {
        ruleId: "autoscaling-no-maxsize",
        severity: "warning",
        message: "Auto-scaling group is missing MaxSize — scaling is unbounded",
        field: "MaxSize",
      };
    }

    return null;
  },
};

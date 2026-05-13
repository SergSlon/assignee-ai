/**
 * EventBridge no-target advisory helper (SX-1, PH1-H-1 BLOCKER Solution B).
 *
 * When the planner produces an `AWS::Events::Rule` resource without any
 * Targets, the rule is syntactically valid but functionally non-operational
 * — it will fire on schedule and silently do nothing. The BP evaluator
 * already emits a CRITICAL finding for this, but the user has no path
 * forward. This advisor adds an actionable HIGH advisory that explains:
 *
 *   1. Why the rule is non-functional (no Target means the event is
 *      discarded — EventBridge does not buffer untargeted events).
 *   2. How to get a working compound (`assignee plan "scheduled lambda ..."`).
 *   3. How to pass an explicit target ARN via `--set Targets=...`.
 *
 * Guard: only fires when `resourceType` is `AWS::Events::Rule` AND
 * `desiredState.Targets` is absent / empty. Does NOT fire when the
 * scheduled-lambda compound routed successfully (those plans have the
 * Rule as a companion resource with `currentResourceIndex > 0`, and
 * the advice-generator skips companions).
 *
 * @see advice-generator.ts — wires this helper alongside securityPosture /
 *   costAlternatives / architectureAdvisor in the rule-based advisor phase.
 */

import { RESOURCE_TYPES } from "@/index.js";
import { AdviceIcon } from "./constants.js";

/**
 * Returns an actionable advisory string array (0 or 1 element) when an
 * `AWS::Events::Rule` is planned without any Targets.
 *
 * @param resourceType  - The CloudFormation resource type string.
 * @param desiredState  - The planned resource properties.
 * @returns Array with one advisory string, or empty array if not applicable.
 */
export function eventbridgeNoTargetHint(
  resourceType: string,
  desiredState: Record<string, unknown>,
): string[] {
  if (resourceType !== RESOURCE_TYPES.EVENTS_RULE) {
    return [];
  }

  const targets = desiredState["Targets"];
  const hasTargets =
    Array.isArray(targets) && (targets as unknown[]).length > 0;

  if (hasTargets) {
    return [];
  }

  return [
    `${AdviceIcon.WARNING} Detected EventBridge rule with no targets — this rule will fire on schedule but discard all events (non-functional). ` +
      `Run 'assignee plan "scheduled lambda <your-schedule>"' for a working 4-resource compound, ` +
      `or pass --set Targets=... to wire an explicit target ARN.`,
  ];
}

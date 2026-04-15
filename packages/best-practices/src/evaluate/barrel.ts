/**
 * evaluateTriggers — the main entry point consumed by the bp_evaluator
 * graph node. Composes context-builder + severity-router + rule-runner +
 * compound-suppressor-link + result-formatter into a single pass.
 *
 * Pure function — no I/O, no side effects, no async.
 * Must complete in <10ms for up to 50 practices.
 */

import type { BestPractice, BPFinding } from "../types.js";
import { getField, type EvalContext } from "./context-builder.js";
import { checkPasses } from "./rule-runner.js";
import { matchesTrigger } from "./severity-router.js";
import { shouldSkipForPattern } from "./compound-suppressor-link.js";
import { buildFinding } from "./result-formatter.js";

/**
 * Evaluate all best practices against a resource configuration.
 *
 * @param context - The resource being evaluated (type + desiredState)
 * @param practices - All loaded BestPractice entries
 * @returns Array of BPFinding for practices that failed their checks
 */
export function evaluateTriggers(
  context: EvalContext,
  practices: BestPractice[],
): BPFinding[] {
  const findings: BPFinding[] = [];

  for (const bp of practices) {
    // Pattern-level exclusion: if any trigger declares excludePatterns
    // containing the current patternId, suppress the entire rule.
    if (
      context.patternId &&
      bp.triggers?.some((t) => t.excludePatterns?.includes(context.patternId!))
    ) {
      continue;
    }

    // Determine if this practice applies to the current resource.
    // resource_type is ALWAYS checked first — triggers add extra conditions
    // (intent keywords, pattern IDs, etc.) but never bypass the type check.
    if (bp.resource_type !== context.resourceType) continue;

    if (bp.triggers !== undefined && bp.triggers.length > 0) {
      // Has explicit triggers — at least one must match
      const anyTriggerMatches = bp.triggers.some((trigger) =>
        matchesTrigger(trigger, context),
      );
      if (!anyTriggerMatches) continue;
    }

    // Compound pattern awareness: skip rules that are satisfied at the pattern level
    // rather than the individual resource level
    if (context.patternId && shouldSkipForPattern(bp, context)) {
      continue;
    }

    // Evaluate the check condition against the desiredState
    const fieldValue = getField(context.desiredState, bp.property_path);
    const passes = checkPasses(bp.check_type, fieldValue, bp.expected_value);

    if (!passes) {
      findings.push(buildFinding(bp));
    }
  }

  return findings;
}

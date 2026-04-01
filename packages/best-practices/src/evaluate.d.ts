import type { BestPractice, BPFinding, Trigger } from "./types.js";
/**
 * Context for evaluating best practice triggers against a resource configuration.
 * Passed by the bp_evaluator graph node (Story 12.3).
 */
export interface EvalContext {
  /** AWS resource type, e.g. "AWS::S3::Bucket" */
  resourceType: string;
  /** Resource configuration from plan_generator desiredState */
  desiredState: Record<string, unknown>;
  /** Original user intent text for intentKeywords matching */
  userIntent?: string;
  /** Compound pattern ID if applicable */
  patternId?: string;
}
/**
 * Traverse a nested object using dot-notation path with array index support.
 * Returns `undefined` if any segment along the path is missing.
 *
 * Supports:
 * - Simple paths: "PublicAccessBlockConfiguration.BlockPublicAcls"
 * - Array index paths: "BlockDeviceMappings[0].Ebs.Encrypted"
 * - Nested arrays: "Rules[0].Conditions[1].Value"
 *
 * @param obj - The object to traverse
 * @param path - Dot-notation path with optional array indices
 * @returns The value at the path, or undefined if not found
 */
export declare function getField(
  obj: Record<string, unknown>,
  path: string,
): unknown;
/**
 * Check whether a single trigger matches the given evaluation context.
 * All set conditions use AND logic — every specified field must match.
 *
 * @param trigger - The trigger definition from a BestPractice
 * @param context - The current evaluation context
 * @returns true if the trigger matches
 */
export declare function matchesTrigger(
  trigger: Trigger,
  context: EvalContext,
): boolean;
/**
 * @param context - The resource being evaluated (type + desiredState)
 * @param practices - All loaded BestPractice entries
 * @returns Array of BPFinding for practices that failed their checks
 */
export declare function evaluateTriggers(
  context: EvalContext,
  practices: BestPractice[],
): BPFinding[];
//# sourceMappingURL=evaluate.d.ts.map

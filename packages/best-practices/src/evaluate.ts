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
export function getField(obj: Record<string, unknown>, path: string): unknown {
  // Split on dots, then handle array indices within each segment
  const segments = path.split(".");
  let current: unknown = obj;

  for (const segment of segments) {
    if (
      current === null ||
      current === undefined ||
      typeof current !== "object"
    ) {
      return undefined;
    }

    // Check for array index notation: "fieldName[0]"
    const arrayMatch = segment.match(/^([^[]+)\[(\d+)\]$/);
    if (arrayMatch) {
      const [, fieldName, indexStr] = arrayMatch;
      const arr = (current as Record<string, unknown>)[fieldName!];
      if (!Array.isArray(arr)) return undefined;
      const index = parseInt(indexStr!, 10);
      current = arr[index];
    } else {
      current = (current as Record<string, unknown>)[segment];
    }
  }

  return current;
}

/**
 * Evaluate a single check_type condition against a field value.
 *
 * @returns true if the check PASSES (best practice is satisfied), false if it FAILS (finding should fire)
 */
function checkPasses(
  checkType: string,
  fieldValue: unknown,
  expectedValue: unknown,
): boolean {
  switch (checkType) {
    case "equals":
      return fieldValue === expectedValue;

    case "not_equals":
      return fieldValue !== expectedValue;

    case "exists":
      return fieldValue !== undefined;

    case "not_exists":
      return fieldValue === undefined;

    case "greater_than": {
      const numField = Number(fieldValue);
      const numExpected = Number(expectedValue);
      if (Number.isNaN(numField) || Number.isNaN(numExpected)) return true;
      return numField > numExpected;
    }

    case "less_than": {
      const numField = Number(fieldValue);
      const numExpected = Number(expectedValue);
      if (Number.isNaN(numField) || Number.isNaN(numExpected)) return true;
      return numField < numExpected;
    }

    default:
      return true;
  }
}

/**
 * Check whether a single trigger matches the given evaluation context.
 * All set conditions use AND logic — every specified field must match.
 *
 * @param trigger - The trigger definition from a BestPractice
 * @param context - The current evaluation context
 * @returns true if the trigger matches
 */
export function matchesTrigger(
  trigger: Trigger,
  context: EvalContext,
): boolean {
  // resourceType filter — if set and does not match, skip
  if (
    trigger.resourceType !== undefined &&
    trigger.resourceType !== context.resourceType
  ) {
    return false;
  }

  // always — if true and resourceType matched (or not set), fire immediately
  if (trigger.always === true) {
    return true;
  }

  // intentKeywords — check if any keyword appears in userIntent (case-insensitive)
  if (
    trigger.intentKeywords !== undefined &&
    trigger.intentKeywords.length > 0
  ) {
    if (!context.userIntent) return false;
    const lowerIntent = context.userIntent.toLowerCase();
    const hasMatch = trigger.intentKeywords.some((kw) =>
      lowerIntent.includes(kw.toLowerCase()),
    );
    if (!hasMatch) return false;
  }

  // patternId — check exact match
  if (trigger.patternId !== undefined) {
    if (trigger.patternId !== context.patternId) return false;
  }

  // fieldCondition — evaluate against desiredState
  // fieldCondition is stored as a string in the Trigger type but not used
  // for direct evaluation here; field evaluation happens via BestPractice's
  // property_path/check_type/expected_value. The trigger-level fieldCondition
  // is for future use. For now, if set, we consider it matched (AND logic
  // with other conditions).

  return true;
}

/**
 * Build a BPFinding from a triggered BestPractice.
 *
 * @param bp - The best practice that fired
 * @returns A finding object for display in the plan box
 */
function buildFinding(bp: BestPractice): BPFinding {
  return {
    practiceId: bp.id,
    title: bp.title,
    severity: bp.severity,
    category: bp.category,
    message:
      bp.description ??
      `${bp.title} — expected ${bp.property_path} ${bp.check_type} ${bp.expected_value}`,
    remediation: bp.remediation,
  };
}

/**
 * Evaluate all best practices against a resource configuration.
 *
 * Pure function — no I/O, no side effects, no async.
 * Must complete in <10ms for up to 50 practices.
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
    // Determine if this practice applies to the current resource
    if (bp.triggers !== undefined && bp.triggers.length > 0) {
      // Has explicit triggers — at least one must match
      const anyTriggerMatches = bp.triggers.some((trigger) =>
        matchesTrigger(trigger, context),
      );
      if (!anyTriggerMatches) continue;
    } else {
      // No triggers array — fall back to matching by resource_type field
      if (bp.resource_type !== context.resourceType) continue;
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

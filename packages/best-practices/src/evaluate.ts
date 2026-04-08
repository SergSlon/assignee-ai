import type { BestPractice, BPFinding, Trigger } from "./types.js";
import {
  inspectPolicyDocument,
  type PolicyAntipattern,
} from "./policy-inspector.js";

/** Pattern ID constant for message-processing — must match @assignee/core PatternId.MESSAGE_PROCESSING */
const PATTERN_MESSAGE_PROCESSING = "message-processing" as const;

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
  // Split on dots that are OUTSIDE bracket pairs so that bracket keys
  // containing dots (e.g. "LoadBalancerAttributes[deletion_protection.enabled]")
  // are preserved as a single segment.
  const segments: string[] = [];
  let buf = "";
  let depth = 0;
  for (let i = 0; i < path.length; i++) {
    const ch = path[i]!;
    if (ch === "[") {
      depth++;
      buf += ch;
    } else if (ch === "]") {
      if (depth > 0) depth--;
      buf += ch;
    } else if (ch === "." && depth === 0) {
      segments.push(buf);
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (buf.length > 0) segments.push(buf);
  let current: unknown = obj;

  for (const segment of segments) {
    if (
      current === null ||
      current === undefined ||
      typeof current !== "object"
    ) {
      return undefined;
    }

    // Check for bracket notation: "fieldName[0]" (numeric) or "fieldName[key]" (string)
    const bracketMatch = segment.match(/^([^[]+)\[(.+)\]$/);
    if (bracketMatch) {
      const [, fieldName, bracketKey] = bracketMatch;
      const container = (current as Record<string, unknown>)[fieldName!];
      if (container === null || container === undefined) return undefined;
      // Numeric index → array access
      if (/^\d+$/.test(bracketKey!)) {
        if (!Array.isArray(container)) return undefined;
        current = container[parseInt(bracketKey!, 10)];
      } else if (Array.isArray(container)) {
        // String key on an array — find element by key match (ELBv2 LoadBalancerAttributes pattern)
        const found = container.find(
          (item) =>
            typeof item === "object" &&
            item !== null &&
            (item as Record<string, unknown>)["Key"] === bracketKey,
        );
        current = found
          ? (found as Record<string, unknown>)["Value"]
          : undefined;
      } else if (typeof container === "object") {
        // String key on an object — direct lookup
        current = (container as Record<string, unknown>)[bracketKey!];
      } else {
        return undefined;
      }
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
      // Missing expected_value or fieldValue → fail to surface the finding
      if (expectedValue === undefined || expectedValue === null) return false;
      if (fieldValue === undefined || fieldValue === null) return false;
      const numField = Number(fieldValue);
      const numExpected = Number(expectedValue);
      // Non-numeric values → fail (surface finding for misconfigured fields)
      if (Number.isNaN(numField) || Number.isNaN(numExpected)) return false;
      return numField > numExpected;
    }

    case "less_than": {
      if (expectedValue === undefined || expectedValue === null) return false;
      if (fieldValue === undefined || fieldValue === null) return false;
      const numField = Number(fieldValue);
      const numExpected = Number(expectedValue);
      if (Number.isNaN(numField) || Number.isNaN(numExpected)) return false;
      return numField < numExpected;
    }

    case "contains": {
      // Missing field cannot contain anything → fail
      if (fieldValue === undefined || fieldValue === null) return false;
      if (typeof fieldValue === "string" && typeof expectedValue === "string") {
        return fieldValue.includes(expectedValue);
      }
      if (Array.isArray(fieldValue)) {
        const expected = JSON.stringify(expectedValue);
        return fieldValue.some((item) => JSON.stringify(item) === expected);
      }
      // Non-string, non-array (number, boolean, object) → cannot "contain" → fail
      return false;
    }

    case "not_contains": {
      // Missing field trivially does not contain the value → pass
      if (fieldValue === undefined || fieldValue === null) return true;
      if (typeof fieldValue === "string" && typeof expectedValue === "string") {
        return !fieldValue.includes(expectedValue);
      }
      if (Array.isArray(fieldValue)) {
        const expected = JSON.stringify(expectedValue);
        return !fieldValue.some((item) => JSON.stringify(item) === expected);
      }
      // Non-string, non-array → cannot meaningfully contain anything → pass
      return true;
    }

    case "conditional_forbidden":
      // Field must not exist when the condition is met. Both undefined and
      // null are treated as "absent" (CFN uses null for unset fields).
      return fieldValue === undefined || fieldValue === null;

    case "awareness":
    case "cross_resource_count":
    case "cross_resource_reference":
      // Awareness checks always "fire" — they surface informational findings.
      return false;

    case "policy_antipattern": {
      // A5.1 BP expansion — IAM/resource policy anti-patterns from the
      // AWS Guard Rules Registry gap analysis. The rule passes (no
      // finding) when the policy document does NOT contain the named
      // pattern; fails (finding fires) when it does.
      //
      // `expected_value` MUST be one of PolicyAntipattern values. If
      // the YAML author mistyped it, the inspector's internal guard
      // returns matched:false and the rule passes silently — not ideal
      // but safer than crashing the pipeline. The rule-authoring tests
      // + Zod schema validation should catch typos before they reach
      // production manifests.
      //
      // Missing fieldValue (no policy document at the property path)
      // also passes — a rule that needs to enforce presence of the
      // policy itself should use `exists` as a second rule.
      if (fieldValue === undefined || fieldValue === null) return true;
      const patternName = expectedValue as PolicyAntipattern;
      const result = inspectPolicyDocument(fieldValue, patternName);
      return !result.matched;
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
  const finding: BPFinding = {
    practiceId: bp.id,
    title: bp.title,
    severity: bp.severity,
    category: bp.category,
    message:
      bp.description ??
      `${bp.title} — expected ${bp.property_path} ${bp.check_type} ${typeof bp.expected_value === "object" ? JSON.stringify(bp.expected_value) : bp.expected_value}`,
    remediation: bp.remediation,
    blocking: bp.blocking ?? false,
  };

  if (bp.autoFixable) {
    finding.autoFixable = true;
    finding.desiredStatePatch = bp.desiredStatePatch;
  }

  // Story 35.5: Always propagate property_path so FixCommandResolver can categorize
  finding.propertyPath = bp.property_path;

  // Story 35.7: Propagate human-readable fix hint
  if (bp.fix_hint) {
    finding.fixHint = bp.fix_hint;
  }

  if (bp.fixType) {
    finding.fixType = bp.fixType;
    finding.interactiveOptions = bp.interactiveOptions;
  }

  // Story 43.1: Propagate consequence text for risk display
  if (bp.consequence) {
    finding.consequence = bp.consequence;
  }

  return finding;
}

/**
 * Evaluate all best practices against a resource configuration.
 *
 * Pure function — no I/O, no side effects, no async.
 * Must complete in <10ms for up to 50 practices.
 *
/**
 * Compound patterns may satisfy certain best practices at the pattern level
 * (e.g., a DLQ is a separate resource in the pattern, not a RedrivePolicy on the queue).
 * Skip these checks when the pattern guarantees the intent is met.
 */
function shouldSkipForPattern(bp: BestPractice, context: EvalContext): boolean {
  // message-processing pattern includes a dedicated DLQ — skip "needs RedrivePolicy" for SQS queues
  if (
    context.patternId === PATTERN_MESSAGE_PROCESSING &&
    bp.id === "BP-SQS-002" // DLQ check
  ) {
    return true;
  }

  // SSE-SQS (SqsManagedSseEnabled) satisfies encryption — skip KMS-specific check
  if (
    bp.id === "BP-SQS-003" &&
    context.desiredState["SqsManagedSseEnabled"] === true
  ) {
    return true;
  }

  return false;
}

/**
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

/**
 * Evaluation context + path traversal helpers.
 *
 * Split from evaluate.ts (W6d F3): single responsibility = building and
 * querying the EvalContext the rule-runner consumes.
 */

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
  /**
   * Advisory codes emitted by the intent-parser pipeline (e.g.
   * "RDS_ENVIRONMENT_TIER_DEFAULTS"). Rules that declare
   * `skip_when_advisory` are suppressed when any of their listed codes
   * appear here — used to prevent production-grade BP findings from
   * contradicting staging/dev tier advisories.
   */
  advisorCodes?: string[];
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

/**
 * Rule-runner: evaluates a single check_type/expected_value/fieldValue triple.
 *
 * Split from evaluate.ts (W6d F3). Pure function — no I/O, no state.
 * Adding a new check type = new case here (OCP: a future registry split
 * can replace the switch without touching callers).
 */

import {
  inspectPolicyDocument,
  type PolicyAntipattern,
} from "../policy-inspector.js";
import { isAwarenessCheck } from "./awareness-filter.js";

/**
 * Evaluate a single check_type condition against a field value.
 *
 * @returns true if the check PASSES (best practice is satisfied), false if it FAILS (finding should fire)
 */
export function checkPasses(
  checkType: string,
  fieldValue: unknown,
  expectedValue: unknown,
): boolean {
  // Awareness-family checks always "fail" so the BP fires as informational.
  if (isAwarenessCheck(checkType)) return false;

  switch (checkType) {
    case "equals":
      return fieldValue === expectedValue;

    case "not_equals":
      return fieldValue !== expectedValue;

    case "exists":
      // "exists" treats empty arrays AND empty strings as absent.
      // An `AWS::Events::Rule` with `Targets: []` is functionally
      // equivalent to a rule with no Targets key — the rule fires
      // but has nowhere to deliver the event. Similarly, an
      // `AccessLogSettings: { DestinationArn: "" }` is equivalent
      // to a missing destination. Treating `undefined` alone as
      // absent would let these configurations silently pass the
      // existence check and surface as broken infrastructure at
      // apply time. A8 follow-up: aligns with the stricter
      // interpretation the rule authors actually intended.
      if (fieldValue === undefined || fieldValue === null) return false;
      if (Array.isArray(fieldValue) && fieldValue.length === 0) return false;
      if (typeof fieldValue === "string" && fieldValue.length === 0)
        return false;
      return true;

    case "not_exists":
      // Symmetric with exists above: empty arrays + strings count
      // as not-exists so `not_exists` rules fire on them too.
      if (fieldValue === undefined || fieldValue === null) return true;
      if (Array.isArray(fieldValue) && fieldValue.length === 0) return true;
      if (typeof fieldValue === "string" && fieldValue.length === 0)
        return true;
      return false;

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

    case "not_contains_pattern": {
      // A1 warmup: pattern-based array element check. Used by BP-IAM-017
      // (elevated *FullAccess managed policies on IAM roles) and any
      // future rule that needs regex matching against array elements
      // where `not_contains` only handles exact equality.
      //
      // Missing field trivially passes — nothing to match. Invalid regex
      // strings also pass; a misconfigured rule should not silently
      // flood findings. The YAML author should have a test in
      // bp-all-rules-audit.test.ts that exercises the pattern.
      if (fieldValue === undefined || fieldValue === null) return true;
      if (typeof expectedValue !== "string") return true;
      let pattern: RegExp;
      try {
        pattern = new RegExp(expectedValue);
      } catch {
        return true;
      }
      if (typeof fieldValue === "string") {
        return !pattern.test(fieldValue);
      }
      if (Array.isArray(fieldValue)) {
        return !fieldValue.some(
          (item) => typeof item === "string" && pattern.test(item),
        );
      }
      return true;
    }

    case "conditional_forbidden":
      // Field must not exist when the condition is met. Both undefined and
      // null are treated as "absent" (CFN uses null for unset fields).
      return fieldValue === undefined || fieldValue === null;

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

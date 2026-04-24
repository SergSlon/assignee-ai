/**
 * Rule-runner: evaluates a single check_type/expected_value/fieldValue triple.
 *
 * Split from evaluate.ts (W6d F3). Pure function — no I/O, no state.
 * Adding a new check type = new case here (OCP: a future registry split
 * can replace the switch without touching callers).
 */

import {
  inspectPolicyDocument,
  isAbsenceAntipattern,
  type PolicyAntipattern,
} from "../policy-inspector.js";
import { isAwarenessCheck } from "./awareness-filter.js";
import { nestedArrayPredicatePasses } from "./predicates/nested-array-predicate.js";

/**
 * Epic 94 R4 (B-02). `expected_value: "0.0.0.0/0:22"` and `"0.0.0.0/0:3389"`
 * are the canonical shapes BP-SG-002 / BP-SG-005 (and any future
 * CIDR+port rule on SG ingress arrays) declare. Without this helper the
 * `not_equals` branch compared the whole ingress array to the string
 * and either always-fired (before R4) or never-fired — neither matched
 * the YAML author's intent.
 *
 * Shape check: `<cidr>:<port>` where cidr is dotted-quad `/mask` and port
 * is 0-65535. The mere presence of `:` rejects IPv6 strings and other
 * accidental matches — dotted-quad v4 only for now.
 */
const CIDR_PORT_RE =
  /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}):(\d{1,5})$/;

/**
 * Grammar for the `sg_high_risk_public_exposure` check_type:
 *   "<cidr>:<port1>,<port2>,...,<portN>"
 *
 * Port list is split on comma post-match. Epic 96 W3.N2 introduced
 * this grammar to replace BP-SG-004's always-firing awareness check
 * (legacy BP-SG-007 slot) — the old rule surfaced DB-focused copy
 * on every SG including port-443-only LB SGs, training users to
 * ignore HIGH severity.
 */
const CIDR_PORT_SET_RE =
  /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}):([\d,]+)$/;

/**
 * True when the candidate value looks like an SG ingress rule object
 * — at minimum has `CidrIp` (string) and ideally `FromPort`/`ToPort`
 * (numbers). Missing port fields are treated as "any port" (the CFN
 * default for `IpProtocol: -1` all-traffic rules).
 */
function looksLikeSgIngressElement(el: unknown): boolean {
  if (el === null || typeof el !== "object") return false;
  const obj = el as Record<string, unknown>;
  return typeof obj["CidrIp"] === "string";
}

/**
 * Check whether the given SG ingress array contains a rule that opens
 * the given CIDR to the given port. Used by the `not_equals` branch to
 * implement the `"cidr:port"` grammar.
 *
 * Semantics: an ingress rule matches when its `CidrIp` equals the
 * target cidr AND (no FromPort/ToPort OR FromPort <= port <= ToPort).
 * All-traffic rules (IpProtocol: -1, no port bounds) are treated as
 * covering every port, matching real AWS SG evaluation behaviour.
 */
function sgIngressOpensCidrPort(
  fieldValue: unknown,
  cidr: string,
  port: number,
): boolean {
  if (!Array.isArray(fieldValue)) return false;
  for (const el of fieldValue) {
    if (!looksLikeSgIngressElement(el)) continue;
    const rule = el as Record<string, unknown>;
    if (rule["CidrIp"] !== cidr) continue;
    const fromRaw = rule["FromPort"];
    const toRaw = rule["ToPort"];
    // Absent bounds → all-traffic / all-ports → matches any port.
    if (fromRaw === undefined && toRaw === undefined) return true;
    const from = typeof fromRaw === "number" ? fromRaw : Number(fromRaw);
    const to = typeof toRaw === "number" ? toRaw : Number(toRaw);
    if (Number.isNaN(from) || Number.isNaN(to)) continue;
    if (from <= port && port <= to) return true;
  }
  return false;
}

/**
 * Parse a `"<cidr>:<p1>,<p2>,..."` expected_value string into its
 * components. Returns `undefined` when the grammar does not match,
 * when any port is out of [0, 65535], or when the port list is empty
 * — the caller treats undefined as "rule silently passes" so a typo
 * in the YAML never triggers a flood of findings.
 */
function parseCidrPortSet(
  value: string,
): { cidr: string; ports: number[] } | undefined {
  const m = CIDR_PORT_SET_RE.exec(value);
  if (m === null) return undefined;
  const cidr = m[1]!;
  const portsRaw = m[2]!;
  const parts = portsRaw.split(",").filter((p) => p.length > 0);
  if (parts.length === 0) return undefined;
  const ports: number[] = [];
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isFinite(n) || n < 0 || n > 65535) return undefined;
    ports.push(n);
  }
  return { cidr, ports };
}

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

    case "not_equals": {
      // Epic 94 R4 (B-02). SG ingress rules (BP-SG-002, BP-SG-005, future
      // port+CIDR rules) declare `expected_value: "0.0.0.0/0:22"` style
      // strings. Detect that grammar and inspect the ingress array
      // properly instead of falling through to a string !== array
      // comparison (which would always fire, guaranteeing false
      // positives). The rule fails (finding fires) when any ingress
      // element actually opens the target cidr to the target port.
      if (typeof expectedValue === "string") {
        const cidrPort = CIDR_PORT_RE.exec(expectedValue);
        if (cidrPort !== null) {
          const [, cidr, portStr] = cidrPort;
          const port = Number(portStr);
          if (!Number.isNaN(port) && port >= 0 && port <= 65535) {
            return !sgIngressOpensCidrPort(fieldValue, cidr!, port);
          }
        }
      }
      return fieldValue !== expectedValue;
    }

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
      // Presence-pattern missing-fieldValue semantics (default):
      //   no policy document at the property path → rule PASSES.
      //   A rule that needs to enforce presence of the policy itself
      //   should use `exists` as a second rule.
      //
      // Absence-pattern missing-fieldValue semantics (Epic 98 W4.B4+):
      //   no policy document means the desired Deny statement is
      //   definitely absent, so the rule FAILS (fires). Routed through
      //   the inspector's absence branch which is tolerant of
      //   undefined/null/malformed documents.
      const patternName =
        typeof expectedValue === "string"
          ? (expectedValue as PolicyAntipattern)
          : undefined;
      if (patternName !== undefined && isAbsenceAntipattern(patternName)) {
        const result = inspectPolicyDocument(fieldValue, patternName);
        return !result.matched;
      }
      if (fieldValue === undefined || fieldValue === null) return true;
      if (patternName === undefined) return true;
      const result = inspectPolicyDocument(fieldValue, patternName);
      return !result.matched;
    }

    case "nested_array_predicate": {
      // Epic 98 W4.B1 — BP-ECS-004 closure. Generic predicate check_type
      // for "every element of an outer array, any element of an inner
      // array matches a regex on a property" — the canonical secret-
      // in-env shape. Grammar + parser live in
      // `./predicates/nested-array-predicate.ts`; malformed grammar or
      // non-array fieldValue PASSES silently (avoids flooding findings
      // on a YAML typo). Future rules that need a JSONPath-filter
      // predicate can reuse this check_type without a bespoke branch.
      if (typeof expectedValue !== "string") return true;
      return nestedArrayPredicatePasses(fieldValue, expectedValue);
    }

    case "sg_high_risk_public_exposure": {
      // Epic 96 W3.N2 — BP-SG-004 narrowing. `expected_value` carries
      // the CIDR + comma-separated port set grammar; the rule fails
      // (finding fires) when any ingress rule opens that CIDR to any
      // port in the set. Mirrors the `not_equals` CIDR:port branch
      // but iterates over the port set.
      //
      // Defensive passes (no finding):
      //   - expected_value not a string / grammar mismatch / out-of-range port
      //   - fieldValue not an SG ingress array (missing / undefined)
      //   - empty port list
      if (typeof expectedValue !== "string") return true;
      const parsed = parseCidrPortSet(expectedValue);
      if (parsed === undefined) return true;
      for (const port of parsed.ports) {
        if (sgIngressOpensCidrPort(fieldValue, parsed.cidr, port)) return false;
      }
      return true;
    }

    default: {
      // Epic 99 Wave 2 W-004 (HIGH): unknown check_type must never silently
      // pass. A typo in a rule YAML (e.g. `check_type: "equls"`) would
      // previously create a no-op rule — the BP appeared to evaluate but
      // always passed, hiding the misconfiguration from YAML authors and
      // consumers.
      //
      // Throwing forces the YAML author to either fix the typo or register
      // the new check_type in the dispatch switch above. The error message
      // includes the rule id and the full list of valid check_types so the
      // author can self-serve without reading source code.
      const validTypes = [
        "equals",
        "not_equals",
        "exists",
        "not_exists",
        "greater_than",
        "less_than",
        "contains",
        "not_contains",
        "not_contains_pattern",
        "conditional_forbidden",
        "policy_antipattern",
        "nested_array_predicate",
        "sg_high_risk_public_exposure",
      ];
      throw new Error(
        `Unknown check_type "${checkType}" encountered in rule-runner. ` +
          `Valid check_types: ${validTypes.join(", ")}. ` +
          `Check the rule YAML for a typo or register the new check_type in rule-runner.ts.`,
      );
    }
  }
}

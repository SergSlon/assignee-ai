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
 * Classified role of a route table, inferred from the Route's desiredState.
 *
 * Sources, in priority order:
 *   1. Explicit `RouteTableType` field on desiredState (reserved hint field
 *      set by pattern-templates or user intent).
 *   2. Explicit `Tags` entry with `Key: "Role"` (case-insensitive on key)
 *      whose `Value` is `public` or `private` (case-insensitive).
 *   3. `RouteTableId` reference inspection — whether a string literal, a
 *      CloudFormation `Ref`, or a `Fn::GetAtt`, a name substring matching
 *      `/(^|[-_/])private([-_/]|$)/i` or `/(^|[-_/])public([-_/]|$)/i`
 *      signals the role. Bare names like `private-route-table`,
 *      `private_rt_primary`, `rt/public`, etc. all match.
 *
 * When no signal resolves to a role (no explicit field, no Role tag, no
 * recognisable name pattern), returns `"unknown"`. BP-RT-001 downgrades
 * to WARN in that case — the BLOCK severity is reserved for the
 * unambiguous private-RT + public-route misconfiguration.
 */
export type RouteTableRole = "private" | "public" | "unknown";

/**
 * Inspect a nested value for a RouteTableId that carries a role substring.
 * Handles raw strings, `{ Ref: "..." }` objects, and `{ "Fn::GetAtt": [...] }`
 * / `{ "Fn::Sub": "..." }` intrinsics.
 */
function extractRouteTableName(rtId: unknown): string | undefined {
  if (typeof rtId === "string") return rtId;
  if (rtId === null || typeof rtId !== "object") return undefined;
  const obj = rtId as Record<string, unknown>;
  if (typeof obj["Ref"] === "string") return obj["Ref"];
  const sub = obj["Fn::Sub"];
  if (typeof sub === "string") return sub;
  if (Array.isArray(sub) && typeof sub[0] === "string") return sub[0];
  const getAtt = obj["Fn::GetAtt"];
  if (typeof getAtt === "string") return getAtt;
  if (Array.isArray(getAtt) && typeof getAtt[0] === "string") return getAtt[0];
  return undefined;
}

/**
 * Classify a route table role from the Route's desiredState.
 * Exported for unit tests and for any future rule that wants to reason about
 * public/private route-table intent without re-implementing the heuristics.
 */
export function classifyRouteTableRole(
  desiredState: Record<string, unknown>,
): RouteTableRole {
  // 1. Explicit hint field — reserved for pattern-template plans + user intent.
  const explicit = desiredState["RouteTableType"];
  if (typeof explicit === "string") {
    const normalised = explicit.toLowerCase();
    if (normalised === "private") return "private";
    if (normalised === "public") return "public";
  }

  // 2. Role tag. Routes themselves do not support Tags, but if an upstream
  //    layer ever copies the RouteTable's tags into the Route's desiredState
  //    for evaluation purposes, we honour them. Tags is expected to be an
  //    array of { Key, Value } objects.
  const tags = desiredState["Tags"];
  if (Array.isArray(tags)) {
    for (const tag of tags) {
      if (typeof tag !== "object" || tag === null) continue;
      const t = tag as Record<string, unknown>;
      const key = t["Key"];
      const value = t["Value"];
      if (typeof key !== "string" || typeof value !== "string") continue;
      if (key.toLowerCase() !== "role") continue;
      const v = value.toLowerCase();
      if (v === "private") return "private";
      if (v === "public") return "public";
    }
  }

  // 3. RouteTableId reference inspection. Pattern templates emit logical
  //    IDs like `private-route-table`, `public-route-table-1`, etc. LLM
  //    plans tend to follow the same convention. We look for "private" or
  //    "public" as a delimited word within the name.
  const rtName = extractRouteTableName(desiredState["RouteTableId"]);
  if (typeof rtName === "string" && rtName.length > 0) {
    if (/(^|[-_/])private([-_/]|$)/i.test(rtName)) return "private";
    if (/(^|[-_/])public([-_/]|$)/i.test(rtName)) return "public";
  }

  return "unknown";
}

/**
 * Post-process a BP-RT-001 finding based on the route table's role.
 *
 * Decision table (role × public-route-present):
 *   - confirmed private + public-route → keep finding (BLOCK, CRITICAL).
 *     The default fixType/interactive options remain intact.
 *   - confirmed public  + public-route → drop finding (rule must not fire).
 *   - unknown           + public-route → downgrade to WARN:
 *       severity = MEDIUM, blocking = false, message augmented with a
 *       hint nudging the user to add an explicit `Role` tag on the
 *       route table so future evaluations resolve deterministically.
 *
 * The public-route precondition is established upstream by the
 * `conditional_forbidden` check on `GatewayId` — if no IGW target is
 * present the finding never reaches this function.
 *
 * @returns the adjusted finding, or `undefined` if the finding must be dropped
 */
function adjustBpRt001ForRole(
  finding: BPFinding,
  role: RouteTableRole,
): BPFinding | undefined {
  if (role === "public") {
    // Public route tables are expected to carry the IGW route — no finding.
    return undefined;
  }
  if (role === "private") {
    // Unambiguous private RT + public route → keep the BLOCK as-is.
    return finding;
  }
  // role === "unknown" → downgrade to a non-blocking WARN.
  return {
    ...finding,
    severity: "MEDIUM",
    blocking: false,
    message:
      `${finding.message} ` +
      "Route table role could not be determined automatically — tag the " +
      "route table with `Role=private` (or `Role=public`) to lock in the " +
      "intended behaviour.",
  };
}

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
      const baseFinding = buildFinding(bp);

      // BP-RT-001 (E92 u.c.3 — findings B-13 + B-17): the underlying
      // `conditional_forbidden` check only verifies that GatewayId is set,
      // which flags every IGW-targeted route regardless of the route
      // table's actual role. That is correct for confirmed-private route
      // tables but a false positive when the route table is clearly
      // public or when the role cannot be determined. Classify the role
      // and either keep, downgrade, or drop the finding accordingly.
      if (bp.id === "BP-RT-001") {
        const role = classifyRouteTableRole(context.desiredState);
        const adjusted = adjustBpRt001ForRole(baseFinding, role);
        if (adjusted) findings.push(adjusted);
        continue;
      }

      findings.push(baseFinding);
    }
  }

  return findings;
}

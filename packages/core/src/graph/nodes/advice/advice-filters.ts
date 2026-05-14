/**
 * Advice post-filters — suppress self-referential and stale advice lines.
 *
 * Self-referential advice: advice that tells the planner to do what the
 * user ALREADY asked (e.g. "Change the TopicName to 'genai-next-events'"
 * when the plan already has `TopicName: "genai-next-events"`).
 *
 * Stale advice: advice describing a property change that matches the
 * value already present in the plan (DF-A2/B3/C4/D4/E4 carryovers).
 *
 * The filter is CONSERVATIVE:
 *   - Only suppresses when the proposed value EXACTLY matches what is
 *     already in the plan.
 *   - Genuine guidance ("Consider Multi-AZ for production reliability",
 *     "Use Reserved Instances for sustained workloads") is preserved.
 *   - IAM / cost-actionable hints are never pattern-matched here.
 *
 * @see Story SX-6 — Suppress self-referential advice lines (PH1-C-4)
 */

/**
 * Patterns that introduce a direct planner instruction.
 * Each regex captures the proposed value in capture group 1 so the
 * caller can cross-reference against the plan.
 */

interface MatchPattern {
  /** Regex applied to the advice line. */
  regex: RegExp;
  /** Extract the proposed string value from match groups. Returns undefined when not determinable. */
  extractValue: (match: RegExpMatchArray) => string | undefined;
  /** Extract the property key from match groups. Returns undefined when not determinable. */
  extractKey: (match: RegExpMatchArray) => string | undefined;
}

/**
 * "Change the <Property> to '<Value>'"
 * "Change <Property> to '<Value>'"
 */
const CHANGE_TO_PATTERN: MatchPattern = {
  regex: /\bchange\s+(?:the\s+)?(\w+)\s+to\s+['"`]([^'"`]+)['"`]/i,
  extractValue: (m) => m[2],
  extractKey: (m) => m[1],
};

/**
 * "Set <Property> to <Value> to match the user intent"
 * "Set the <Property> to '<Value>'"
 */
const SET_TO_PATTERN: MatchPattern = {
  regex:
    /\bset\s+(?:the\s+)?(\w+)\s+to\s+['"`]?([^'"`,.]+?)['"`]?(?:\s+to\s+match|\s+for\s+|\s*$)/i,
  extractValue: (m) => m[2]?.trim(),
  extractKey: (m) => m[1],
};

/**
 * "Update the <Property> to '<Value>'"
 */
const UPDATE_TO_PATTERN: MatchPattern = {
  regex: /\bupdate\s+(?:the\s+)?(\w+)\s+to\s+['"`]([^'"`]+)['"`]/i,
  extractValue: (m) => m[2],
  extractKey: (m) => m[1],
};

/**
 * Stale already-applied boolean/flag patterns:
 * "Enable <PropertyName>" when plan already has <PropertyName>: true
 */
const ENABLE_PATTERN: MatchPattern = {
  regex: /\benable\s+(\w[\w.]+)/i,
  extractValue: (_m) => undefined, // boolean check — no string value needed
  extractKey: (m) => m[1],
};

const ALL_PATTERNS: MatchPattern[] = [
  CHANGE_TO_PATTERN,
  SET_TO_PATTERN,
  UPDATE_TO_PATTERN,
  ENABLE_PATTERN,
];

/**
 * Recursively search for a property key in the plan object.
 * Keys are matched case-insensitively to tolerate CamelCase drift.
 *
 * Returns the value if found, or `undefined`.
 */
function findPlanValue(
  plan: Record<string, unknown>,
  targetKey: string,
): unknown {
  const lower = targetKey.toLowerCase();
  for (const [k, v] of Object.entries(plan)) {
    if (k.toLowerCase() === lower) return v;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const nested = findPlanValue(v as Record<string, unknown>, targetKey);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

/**
 * Returns true when the advice line should be suppressed.
 *
 * Suppression criteria:
 *   - The line matches a direct-instruction pattern, AND
 *   - The proposed value is already present in the plan for that key.
 *
 * For "Enable <Property>": suppressed when plan[property] is truthy (true / "enabled" / non-empty).
 */
function isSelfReferential(
  line: string,
  plan: Record<string, unknown>,
): boolean {
  for (const pattern of ALL_PATTERNS) {
    const match = line.match(pattern.regex);
    if (!match) continue;

    const key = pattern.extractKey(match);
    if (!key) continue;

    const planValue = findPlanValue(plan, key);
    if (planValue === undefined) continue; // key absent → keep the advice

    if (pattern === ENABLE_PATTERN) {
      // Stale boolean advice: suppress if plan value is truthy
      if (
        planValue === true ||
        planValue === "enabled" ||
        planValue === "true"
      ) {
        return true;
      }
      continue;
    }

    const proposedValue = pattern.extractValue(match);
    if (proposedValue === undefined) continue;

    // Stringify plan value for comparison (handles numbers stored as strings)
    const planStr = String(planValue).trim();
    if (planStr === proposedValue.trim()) {
      return true;
    }
  }
  return false;
}

/**
 * Post-filter pass applied to all advice hint lines before render.
 *
 * Removes lines that:
 *   1. Use a "Change/Set/Update/Enable" verb pattern, AND
 *   2. The proposed change already matches the current plan value.
 *
 * Lines that do NOT match any pattern are always preserved (e.g.
 * "Consider Multi-AZ for production reliability",
 * "Use Reserved Instances for sustained workloads").
 *
 * @param adviceLines  Raw advice strings from LLM + rule-based advisors.
 * @param plan         The current desiredState / plan object to cross-reference.
 * @returns            Filtered lines with self-referential entries removed.
 */
export function filterSelfReferentialAdvice(
  adviceLines: string[],
  plan: Record<string, unknown>,
): string[] {
  return adviceLines.filter((line) => !isSelfReferential(line, plan));
}

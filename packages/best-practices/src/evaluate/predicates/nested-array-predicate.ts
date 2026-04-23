/**
 * `nested_array_predicate` check_type — JSONPath-like predicate evaluation
 * against a nested array within every element of an outer array field.
 *
 * Architectural decision: bp-audit §6.1. Before Epic 98 W4.B1, rules that
 * needed to detect "any element of an inner array inside every element of
 * an outer array matches a regex" (the canonical secret-in-env shape of
 * BP-ECS-004) had to be marked `check_type: awareness` — which always
 * fires, regardless of whether the actual payload carried a match. That
 * trained users to ignore CRITICAL severity on BP-ECS-004 because the
 * rule surfaced on every ECS task def.
 *
 * This predicate is the generic fix. A rule declares:
 *   - `property_path: ContainerDefinitions` (outer array)
 *   - `check_type: nested_array_predicate`
 *   - `expected_value: "Environment[?(@.Name=~/<regex>/)] does not exist"`
 *
 * The grammar of `expected_value` is:
 *
 *   "<innerArray>[?(@.<prop>=~/<regex>/<flags>)] does not exist"
 *
 *     innerArray — JS identifier naming the inner array field (e.g.
 *                  `Environment`). Looked up on every element of the
 *                  outer array.
 *     prop       — JS identifier naming the property to match on each
 *                  inner-array element (e.g. `Name`).
 *     regex      — JavaScript regex source. May contain `/` via
 *                  `\/` escape but typical BP rules use character
 *                  classes so escaping is rarely needed.
 *     flags      — optional `i`/`m`/`s` modifiers. Multiple allowed.
 *
 * The trailing literal ` does not exist` asserts the rule semantics:
 * the check PASSES when no matching element exists in any inner array,
 * FAILS (fires) when at least one inner element matches.
 *
 * Defensive posture: a malformed `expected_value` (bad grammar, invalid
 * regex, missing trailing literal) causes the rule to PASS silently. A
 * typo in the YAML must never flood findings. The rule-authoring tests
 * (bp-ecs-004-scope.test.ts + the predicate unit tests) are the net
 * that catches grammar drift before it ships.
 *
 * Non-array `fieldValue` (missing outer property) also PASSES silently —
 * a rule that needs the outer array to exist should declare a second
 * rule with `check_type: exists` on the same path.
 */

/**
 * Parsed form of the nested-array-predicate grammar. Each successful
 * parse returns one; malformed input returns `undefined`.
 */
export interface NestedArrayPredicate {
  /** Name of the inner array field on each outer-array element. */
  innerArrayField: string;
  /** Name of the property on each inner-array element to match. */
  propName: string;
  /** Compiled regex ready to `.test()` against the property value. */
  pattern: RegExp;
}

/**
 * Grammar: `<ident>[?(@.<ident>=~/<regex-body>/<flags>)] does not exist`
 *
 * Regex body uses a non-greedy match up to the first un-escaped `/`
 * followed by optional flag characters. Flags are restricted to
 * common JS regex modifiers to reject typos like `/foo/xyz`.
 */
const PREDICATE_GRAMMAR_RE =
  /^([A-Za-z_][\w]*)\[\?\(@\.([A-Za-z_][\w]*)=~\/(.+?)\/([gimsuy]*)\)\]\s+does not exist$/;

/**
 * Parse the nested-array-predicate grammar into its components.
 * Returns `undefined` when the grammar does not match or the regex
 * body fails to compile.
 */
export function parseNestedArrayPredicate(
  expression: string,
): NestedArrayPredicate | undefined {
  if (typeof expression !== "string") return undefined;
  const m = PREDICATE_GRAMMAR_RE.exec(expression);
  if (m === null) return undefined;
  const [, innerArrayField, propName, regexBody, flags] = m;
  try {
    const pattern = new RegExp(regexBody!, flags ?? "");
    return {
      innerArrayField: innerArrayField!,
      propName: propName!,
      pattern,
    };
  } catch {
    return undefined;
  }
}

/**
 * Evaluate the predicate against the outer-array `fieldValue`.
 *
 * @param fieldValue - The resolved outer array (e.g. ContainerDefinitions).
 *                     Non-array values PASS silently (nothing to match).
 * @param expression - The expected_value string using the predicate grammar.
 * @returns `true` when the rule PASSES (no matching inner element found),
 *          `false` when the rule FAILS (at least one match → finding fires).
 */
export function nestedArrayPredicatePasses(
  fieldValue: unknown,
  expression: string,
): boolean {
  const parsed = parseNestedArrayPredicate(expression);
  if (parsed === undefined) return true;
  if (!Array.isArray(fieldValue)) return true;

  for (const outerEl of fieldValue) {
    if (outerEl === null || typeof outerEl !== "object") continue;
    const innerArray = (outerEl as Record<string, unknown>)[
      parsed.innerArrayField
    ];
    if (!Array.isArray(innerArray)) continue;
    for (const innerEl of innerArray) {
      if (innerEl === null || typeof innerEl !== "object") continue;
      const propValue = (innerEl as Record<string, unknown>)[parsed.propName];
      if (typeof propValue !== "string") continue;
      if (parsed.pattern.test(propValue)) {
        return false;
      }
    }
  }
  return true;
}

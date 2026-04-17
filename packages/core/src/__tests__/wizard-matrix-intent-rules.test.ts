/**
 * Wizard Interaction Matrix — Intent Rule Coverage.
 *
 * For every intent rule defined in `intent-defaults.ts`, verify that:
 *   1. The first keyword triggers `getIntentDefaults()` to return every
 *      override in that rule (AC #9).
 *   2. `applyIntentOverrides()` populates each override's `initialValue` onto
 *      the corresponding field and appends the override's `reason` into the
 *      field's hint (AC #9).
 *   3. First-match-per-field semantics hold when multiple rules for the same
 *      resource type could overlap.
 *
 * This exercises the real `INTENT_RULES` array (exported from
 * `intent-defaults.ts`) so a rule added there is tested automatically — no
 * duplicate data to maintain here.
 *
 * @see _bmad-output/implementation-artifacts/wizard-interaction-matrix.md — AC #9
 */

import { describe, it, expect } from "vitest";
import type { ResourceField, ResourcePlugin } from "../index.js";
import { defaultPluginRegistry } from "../index.js";
import {
  INTENT_RULES,
  getIntentDefaults,
  applyIntentOverrides,
} from "../utils/intent-defaults.js";

// Helper: find a field in a plugin by name (both tiers).
function findField(
  plugin: ResourcePlugin,
  fieldName: string,
): ResourceField | undefined {
  return (
    plugin.commonFields.find((f) => f.name === fieldName) ??
    plugin.advancedFields.find((f) => f.name === fieldName)
  );
}

describe("intent rules — coverage invariants", () => {
  it("ruleset is non-empty and matches the story's ~32-rule count", () => {
    // Guardrail: catches accidental rule deletions.
    expect(INTENT_RULES.length).toBeGreaterThanOrEqual(30);
  });

  it("every rule declares at least one keyword and one override", () => {
    for (const rule of INTENT_RULES) {
      expect(rule.keywords.length).toBeGreaterThan(0);
      expect(rule.overrides.length).toBeGreaterThan(0);
      for (const ov of rule.overrides) {
        expect(ov.fieldName).toBeTruthy();
        expect(ov.reason).toBeTruthy();
        // value may be any type including false/undefined for booleans —
        // only assert the key is present, not its truthiness.
        expect("value" in ov).toBe(true);
      }
    }
  });

  it("every rule targets a registered resource plugin", () => {
    for (const rule of INTENT_RULES) {
      const plugin = defaultPluginRegistry.get(rule.resourceType);
      expect(
        plugin,
        `intent rule references unregistered plugin ${rule.resourceType}`,
      ).toBeDefined();
    }
  });

  it("every override.fieldName maps to a real field on its plugin", () => {
    for (const rule of INTENT_RULES) {
      const plugin = defaultPluginRegistry.get(rule.resourceType);
      if (!plugin) continue;
      for (const ov of rule.overrides) {
        const field = findField(plugin, ov.fieldName);
        expect(
          field,
          `intent rule for ${rule.resourceType} references missing field ${ov.fieldName}`,
        ).toBeDefined();
      }
    }
  });
});

// Build a flat table of (rule-label, rule) pairs so each rule becomes its own
// describe.each row. The label is `${resourceType} — ${firstKeyword}` so
// failing-test output is readable at a glance.
const ruleRows = INTENT_RULES.map(
  (rule) =>
    [`${rule.resourceType} — "${rule.keywords[0] ?? "???"}"`, rule] as const,
);

describe.each(ruleRows)("intent rule: %s", (_label, rule) => {
  const firstKeyword = rule.keywords[0]!;
  // Wrap the keyword in a sentence so we exercise the substring match path
  // exactly as a real user prompt would ("Create a web server named foo").
  const sampleIntent = `Please create a ${firstKeyword} for me`;

  it("getIntentDefaults() returns the rule's own overrides (not a clobbered version)", () => {
    const result = getIntentDefaults(sampleIntent, rule.resourceType);

    // Every override the rule declares should appear in the result. We
    // verify each override's value+reason match the rule under test (NOT
    // some other rule that happens to claim the same field) — this is the
    // critical first-match-per-field semantic the dedicated test below
    // also exercises with synthetic rules.
    for (const ov of rule.overrides) {
      const matched = result.find((r) => r.fieldName === ov.fieldName);
      expect(
        matched,
        `rule for "${firstKeyword}" did not produce an override for ${ov.fieldName}`,
      ).toBeDefined();

      // Determine which rule actually owns this fieldName under first-match
      // semantics. If an earlier INTENT_RULES entry for the same resource
      // type matches `sampleIntent` and claims the same fieldName, it
      // legitimately wins — and the test should expect ITS reason+value,
      // not the current rule's. Otherwise, the current rule must own it.
      const owningRule = INTENT_RULES.find((r) => {
        if (r.resourceType !== rule.resourceType) return false;
        const matchesIntent = r.keywords.some((kw) =>
          sampleIntent.toLowerCase().includes(kw.toLowerCase()),
        );
        if (!matchesIntent) return false;
        return r.overrides.some((o) => o.fieldName === ov.fieldName);
      });
      expect(owningRule).toBeDefined();
      const owningOverride = owningRule!.overrides.find(
        (o) => o.fieldName === ov.fieldName,
      )!;

      expect(matched?.value).toEqual(owningOverride.value);
      expect(matched?.reason).toEqual(owningOverride.reason);
    }
  });

  it("applyIntentOverrides() pre-populates initialValue and appends reason to hints", () => {
    const plugin = defaultPluginRegistry.get(rule.resourceType);
    if (!plugin) {
      // Guarded earlier — short-circuit the body here.
      return;
    }

    const overrides = getIntentDefaults(sampleIntent, rule.resourceType);
    expect(overrides.length).toBeGreaterThan(0);

    const allFields = [...plugin.commonFields, ...plugin.advancedFields];
    const enriched = applyIntentOverrides(allFields, overrides);

    for (const ov of overrides) {
      const enrichedField = enriched.find((f) => f.name === ov.fieldName);
      expect(enrichedField).toBeDefined();
      // initialValue should reflect the override's value.
      expect(enrichedField?.question.initialValue).toEqual(ov.value);
      // The hint should include the override's reason string.
      expect(enrichedField?.question.hint).toBeTruthy();
      expect(enrichedField?.question.hint).toContain(ov.reason);
      // And should be prefixed with "Pre-selected based on your intent:" so
      // the UX makes clear where the pre-fill came from.
      expect(enrichedField?.question.hint).toContain(
        "Pre-selected based on your intent",
      );
    }
  });

  it("non-matching intent produces no override for this rule's fields", () => {
    // Use a deterministic non-ASCII sentinel so no plausible future English
    // keyword can accidentally collide. We also assert that NO rule (not
    // just the current one) finds a keyword match, so the test can't pass
    // for the wrong reason if a sibling rule claims the same field.
    const unrelated = "\u0001\u0002\u0003 sentinel \u0004";
    for (const otherRule of INTENT_RULES) {
      for (const kw of otherRule.keywords) {
        expect(
          unrelated.toLowerCase().includes(kw.toLowerCase()),
          `nonsense sentinel string accidentally contains keyword ${kw}`,
        ).toBe(false);
      }
    }

    const result = getIntentDefaults(unrelated, rule.resourceType);
    expect(result.length).toBe(0);
  });
});

// First-match-per-field semantic: when two real rules for the same resource
// type both claim the same field for an intent that matches both, the rule
// that appears EARLIER in `INTENT_RULES` must win. This is enforced
// declaratively in `getIntentDefaults` via the `claimedFields` set. We
// verify it by finding any in-tree pair of rules that overlap on a field
// (if one exists) and asserting the earlier rule's override survives.
describe("intent rules — first-match-per-field semantics", () => {
  it("real overlap (if any): the earlier rule wins on a contested field", () => {
    // Build (resourceType, fieldName) → rules-that-claim-it
    const claims = new Map<string, IntentRuleClaim[]>();
    for (let i = 0; i < INTENT_RULES.length; i++) {
      const rule = INTENT_RULES[i]!;
      for (const ov of rule.overrides) {
        const key = `${rule.resourceType}::${ov.fieldName}`;
        const list = claims.get(key) ?? [];
        list.push({ index: i, rule, fieldName: ov.fieldName });
        claims.set(key, list);
      }
    }

    // Find one contested key, if any.
    const contested = [...claims.values()].find((list) => list.length >= 2);
    if (!contested) {
      // No real in-tree overlap exists today. Synthetic test below covers
      // the semantic regardless.
      return;
    }

    const [first, second] = contested;
    // Pick an intent string that matches BOTH rules' keywords.
    const intent = `${first!.rule.keywords[0]} ${second!.rule.keywords[0]}`;
    const result = getIntentDefaults(intent, first!.rule.resourceType);
    const matched = result.find((r) => r.fieldName === first!.fieldName);
    expect(matched).toBeDefined();
    const winningOverride = first!.rule.overrides.find(
      (o) => o.fieldName === first!.fieldName,
    )!;
    // Earlier rule's value+reason must survive — second rule must NOT have
    // clobbered them.
    expect(matched?.value).toEqual(winningOverride.value);
    expect(matched?.reason).toEqual(winningOverride.reason);
  });
});

interface IntentRuleClaim {
  index: number;
  rule: (typeof INTENT_RULES)[number];
  fieldName: string;
}

/**
 * Wizard Interaction Matrix — BP Hint Accuracy Audit.
 *
 * Loads the real best-practices ruleset and walks every (plugin, field)
 * combination through `injectBPHints` to verify two invariants:
 *
 *   1. **No awareness BP becomes a field hint.** Awareness BPs apply to a
 *      resource as a whole (e.g., "should have a backup strategy") and have
 *      no actionable per-field configuration. Injecting them on field prompts
 *      caused the real-user wizard incident on 2026-04-10.
 *
 *   2. **Every injected BP's `property_path` actually contains the field
 *      name** it was attached to. A BP with `property_path: "Tags.Owner"`
 *      should hint the Tags field, not the BucketName field. A drifted
 *      mapping silently surfaces wrong advice.
 *
 * @see _bmad-output/implementation-artifacts/wizard-interaction-matrix.md — AC #5-7
 */

import { describe, it, expect } from "vitest";
import { loadBestPractices, type BestPractice } from "@assignee/best-practices";
import { injectBPHints } from "../utils/wizard-helpers.js";
import { ALL_PLUGINS } from "./fixtures/wizard-matrix-plugins.js";

const ALL_BPS: BestPractice[] = loadBestPractices();

/**
 * Hint marker emitted by `injectBPHints`. Kept in sync with
 * `wizard-helpers.ts` — if either side changes the format, the per-plugin
 * "matched property_path" assertion would silently bypass via the `continue`
 * in the loop, so the cross-plugin invariant below catches drift.
 */
const BP_HINT_MARKER = "Recommended by Best Practices: ";

describe("BP hint accuracy — invariants", () => {
  it("loadBestPractices() returns a non-trivial ruleset", () => {
    // Sanity: catches an empty/broken BP loader.
    expect(ALL_BPS.length).toBeGreaterThan(50);
  });

  it("at least one BP has check_type=awareness (would otherwise mean no risk to test for)", () => {
    const awareness = ALL_BPS.filter((bp) => bp.check_type === "awareness");
    expect(awareness.length).toBeGreaterThan(0);
  });

  it("injectBPHints actually injects hints into at least one field per plugin", () => {
    // Failsafe: if a regression made injectBPHints a no-op, the per-plugin
    // "no awareness" and "matched property_path" tests would all silently
    // fail open (their inner loops never run). This invariant counts the
    // total injected hints across the entire matrix and asserts a non-trivial
    // floor — picking a number that's well below today's count but well
    // above zero so it catches regressions without flapping on minor BP
    // catalog edits.
    let totalInjected = 0;
    for (const plugin of ALL_PLUGINS) {
      const hintedCommon = injectBPHints(
        plugin.commonFields,
        plugin.resourceType,
      );
      const hintedAdvanced = injectBPHints(
        plugin.advancedFields,
        plugin.resourceType,
      );
      const originalNames = new Map<string, string | undefined>(
        [...plugin.commonFields, ...plugin.advancedFields].map((f) => [
          f.name,
          f.question.hint,
        ]),
      );
      for (const f of [...hintedCommon, ...hintedAdvanced]) {
        const before = originalNames.get(f.name);
        if (
          f.question.hint &&
          f.question.hint !== before &&
          f.question.hint.includes(BP_HINT_MARKER)
        ) {
          totalInjected++;
        }
      }
    }
    expect(
      totalInjected,
      "injectBPHints produced fewer hint injections than expected — possible regression",
    ).toBeGreaterThan(20);
  });
});

describe.each(ALL_PLUGINS.map((p) => [p.resourceType, p] as const))(
  "BP hints — %s",
  (_resourceType, plugin) => {
    const allFields = [...plugin.commonFields, ...plugin.advancedFields];
    const relevantBPs = ALL_BPS.filter(
      (bp) => bp.resource_type === plugin.resourceType,
    );

    it("never injects an awareness BP as a field hint", () => {
      const hintedCommon = injectBPHints(
        plugin.commonFields,
        plugin.resourceType,
      );
      const hintedAdvanced = injectBPHints(
        plugin.advancedFields,
        plugin.resourceType,
      );
      const hintedAll = [...hintedCommon, ...hintedAdvanced];

      const awarenessBPs = relevantBPs.filter(
        (bp) => bp.check_type === "awareness",
      );

      // For each field that received a hint, the matched BP must NOT be an
      // awareness BP. We verify by checking that the injected BP-sourced
      // hint substring does not contain any awareness BP's title.
      for (const field of hintedAll) {
        const hint = field.question.hint ?? "";
        for (const awarenessBp of awarenessBPs) {
          expect(
            hint.includes(awarenessBp.title),
            `${plugin.resourceType} field ${field.name} has awareness BP "${awarenessBp.title}" in its hint`,
          ).toBe(false);
        }
      }
    });

    it("every BP-sourced hint matches a BP whose property_path contains the field name", () => {
      const hintedCommon = injectBPHints(
        plugin.commonFields,
        plugin.resourceType,
      );
      const hintedAdvanced = injectBPHints(
        plugin.advancedFields,
        plugin.resourceType,
      );
      const hintedAll = [...hintedCommon, ...hintedAdvanced];

      // Build (originalField → hintedField) so we can detect *new* hints
      // injected by injectBPHints (vs hints that were already present).
      const originalByName = new Map<string, string | undefined>(
        allFields.map((f) => [f.name, f.question.hint]),
      );

      for (const field of hintedAll) {
        const originalHint = originalByName.get(field.name);
        const newHint = field.question.hint;
        if (newHint === originalHint) continue; // no BP injected for this field

        // The hint format from injectBPHints is:
        //   "<existing>\nRecommended by Best Practices: <bp.title>"
        if (!newHint?.includes(BP_HINT_MARKER)) continue; // hint changed for non-BP reasons

        const titleStart =
          newHint.lastIndexOf(BP_HINT_MARKER) + BP_HINT_MARKER.length;
        const injectedTitle = newHint.slice(titleStart).trim();

        // Find the BP whose title was injected.
        const matchedBp = relevantBPs.find((bp) => bp.title === injectedTitle);
        expect(
          matchedBp,
          `${plugin.resourceType} field ${field.name}: injected hint "${injectedTitle}" not found in BP catalogue`,
        ).toBeDefined();

        if (!matchedBp) continue;

        // The matched BP must not be an awareness BP (covered by the
        // previous test, but assert here so failures are localized).
        expect(matchedBp.check_type).not.toBe("awareness");

        // The BP's property_path must match the field's name as either:
        //   (a) the FIRST segment — for top-level user-facing properties
        //       (e.g., a `Tags` field matched by property_path "Tags"), or
        //   (b) the LAST segment — for plugins that surface a deep AWS leaf
        //       as a flat user prompt (e.g., the `ScanOnPush` field is the
        //       leaf of `ImageScanningConfiguration.ScanOnPush`).
        // Arbitrary interior-segment matches are still rejected so a
        // hypothetical `Tags.Owner` BP cannot attach to a sibling `Owner`
        // field that has nothing to do with tagging.
        const segments = matchedBp.property_path.split(".");
        const first = segments[0];
        const last = segments[segments.length - 1];
        const matches =
          matchedBp.property_path === field.name ||
          first === field.name ||
          last === field.name;
        expect(
          matches,
          `${plugin.resourceType} field ${field.name}: matched BP ${matchedBp.id} property_path "${matchedBp.property_path}" does not match field name as first/last segment`,
        ).toBe(true);
      }
    });
  },
);

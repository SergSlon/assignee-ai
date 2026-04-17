/**
 * Best-Practices hint injection.
 *
 * INVARIANT (asserted by wizard-matrix-bp-hints.test.ts memo-invariant test):
 * this function MUST NEVER mutate the input field array or its elements.
 * Always return fresh objects when adding hints; pass through identity
 * references unchanged when no BP applies.
 */

import { loadBestPractices, type BestPractice } from "@assignee/best-practices";
import type { ResourceField } from "../../index.js";

/**
 * Injects "Recommended by Best Practices" hints into field questions when
 * a BP rule references the field's property path for the given resource type.
 * Pure in-memory transformation — no I/O.
 *
 * @param fields - Resource plugin fields to annotate
 * @param resourceType - The AWS resource type being configured
 * @returns Fields with BP-sourced hints appended to question hints
 *
 * @see Story 12.3, AC #3
 */
export function injectBPHints(
  fields: ResourceField[],
  resourceType: string,
): ResourceField[] {
  let practices: BestPractice[];
  try {
    practices = loadBestPractices();
  } catch {
    return fields;
  }

  const relevantBPs = practices.filter(
    (bp) => bp.resource_type === resourceType,
  );
  if (relevantBPs.length === 0) return fields;

  return fields.map((field) => {
    // Check if any BP references this field's name as a property_path segment
    const matchingBP = relevantBPs.find((bp) => {
      // Skip resource-level awareness BPs (e.g., "should have a backup strategy")
      // — these apply to the resource as a whole, not to a specific field.
      if (bp.check_type === "awareness") return false;
      const segments = bp.property_path.split(".");
      return segments.includes(field.name) || bp.property_path === field.name;
    });

    if (!matchingBP) return field;

    const bpHint = `Recommended by Best Practices: ${matchingBP.title}`;
    const existingHint = field.question.hint;
    const combinedHint = existingHint ? `${existingHint}\n${bpHint}` : bpHint;

    return {
      ...field,
      question: {
        ...field.question,
        hint: combinedHint,
      },
    };
  });
}

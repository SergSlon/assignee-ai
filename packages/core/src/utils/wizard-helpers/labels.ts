/**
 * Label enrichment, category smart-filter, and option ranking.
 * Pure transformations — no I/O, no input mutation.
 */

import { QuestionTypeName } from "../../index.js";
import type { ResourceField } from "../../index.js";
import { enrichOptionLabel } from "../option-enrichment.js";
import { rankOptions } from "../option-ranker.js";
import type { WorkloadProfile } from "../workload-classifier.js";
import { InstanceCategory } from "../../constants/instance-categories.js";
import { WorkloadProfileKey as WP } from "../../config/cfn-keys/display.js";

/**
 * Enriches enum option labels with contextual metadata (cost/fit/recommended).
 * Pure in-memory transformation — no I/O, no mutations.
 * Only enriches in TTY mode (display-only).
 */
export function enrichFieldLabels(fields: ResourceField[]): ResourceField[] {
  if (!process.stdout.isTTY) return fields;
  return fields.map((field) => {
    if (
      field.question.type === QuestionTypeName.CATEGORY_SELECT &&
      field.question.categories
    ) {
      return {
        ...field,
        question: {
          ...field.question,
          categories: field.question.categories.map((cat) => ({
            ...cat,
            options: cat.options.map((opt) => ({
              ...opt,
              label: enrichOptionLabel(opt),
            })),
          })),
        },
      };
    }
    if (field.question.type !== "enum" || !field.question.options) return field;
    return {
      ...field,
      question: {
        ...field.question,
        options: field.question.options.map((opt) => ({
          ...opt,
          label: enrichOptionLabel(opt),
        })),
      },
    };
  });
}

/**
 * Maps a workload profile to the corresponding category key used in the
 * EC2 InstanceType categorySelect field.
 * Returns undefined for profiles that don't map to a known category (gpu-accelerated, storage-heavy, unknown).
 *
 * @see Story 21.3
 */
const PROFILE_TO_CATEGORY: Partial<Record<WorkloadProfile, string>> = {
  [InstanceCategory.BURSTABLE]: WP.BURSTABLE,
  [InstanceCategory.GENERAL_PURPOSE]: WP.GENERAL,
  [InstanceCategory.COMPUTE_HEAVY]: WP.COMPUTE,
  [InstanceCategory.MEMORY_INTENSIVE]: WP.MEMORY,
};

/** GPU note shown when gpu-accelerated profile is detected. */
const GPU_CATEGORY_NOTE =
  "GPU instances not in categories \u2014 use 'Other' for p5/g6 types";

/**
 * Applies workload-based smart filtering to categorySelect fields (e.g., EC2 InstanceType).
 *
 * - Reorders categories so the workload-matching category appears first
 * - Appends "(recommended for your workload)" hint to the matching category label
 * - Ranks options within the matching category using `rankOptions()`
 * - For gpu-accelerated profile: adds a note via the field hint
 * - For unknown/undefined profile: no changes
 *
 * Pure transformation — no I/O, no mutations to inputs.
 *
 * @see Story 21.3
 */
export function applyCategorySmartFilter(
  fields: ResourceField[],
  profile: WorkloadProfile | undefined,
): ResourceField[] {
  if (!profile || profile === WP.UNKNOWN) return fields;

  const targetCategory = PROFILE_TO_CATEGORY[profile];

  return fields.map((field) => {
    if (
      field.question.type !== QuestionTypeName.CATEGORY_SELECT ||
      !field.question.categories
    ) {
      return field;
    }

    // GPU profile: no matching category, just add a hint
    if (
      profile === InstanceCategory.GPU_ACCELERATED ||
      profile === InstanceCategory.STORAGE_HEAVY
    ) {
      const gpuHint =
        profile === "gpu-accelerated" ? GPU_CATEGORY_NOTE : undefined;
      if (!gpuHint) return field;
      const existingHint = field.question.hint;
      return {
        ...field,
        question: {
          ...field.question,
          hint: existingHint ? `${existingHint}\n${gpuHint}` : gpuHint,
        },
      };
    }

    if (!targetCategory) return field;

    // Mutable copy of categories array for reordering
    const categories = [...field.question.categories];
    const matchIdx = categories.findIndex((c) => c.key === targetCategory);
    if (matchIdx < 0) return field;

    // Rank options within the matching category
    const matchedCat = categories[matchIdx]!;
    const ranked = rankOptions(
      [...matchedCat.options] as Array<
        { value: string; label: string } & Record<string, unknown>
      >,
      profile,
      matchedCat.options.length,
    );
    const rankedOptions = [...ranked.visible, ...ranked.overflow];

    // Build the enhanced matching category with "(recommended for your workload)" label
    const enhancedCat = {
      ...matchedCat,
      label: `${matchedCat.label} (recommended for your workload)`,
      options: rankedOptions,
    };

    // Reorder: put matching category first, keep others in original order
    const reordered = [
      enhancedCat,
      ...categories.filter((_, i) => i !== matchIdx),
    ];

    return {
      ...field,
      question: {
        ...field.question,
        categories: reordered,
      },
    };
  });
}

/**
 * Applies workload-based ranking to enum fields with many options (>10).
 * Reorders options so the most relevant ones appear first.
 * Only applies when a known workload profile is detected; "unknown" skips ranking.
 *
 * @see Story 21.4
 */
export function applyOptionRanking(
  fields: ResourceField[],
  profile: WorkloadProfile,
): ResourceField[] {
  if (profile === WP.UNKNOWN) return fields;

  return fields.map((field) => {
    if (field.question.type !== "enum" || !field.question.options) return field;
    if (field.question.options.length <= 10) return field;

    const ranked = rankOptions(
      [...field.question.options] as Array<
        { value: string; label: string } & Record<string, unknown>
      >,
      profile,
      field.question.options.length,
    );

    // If ranking was not applied (e.g. unknown profile fallback), keep original order
    if (!ranked.filtered) return field;

    return {
      ...field,
      question: {
        ...field.question,
        options: [...ranked.visible, ...ranked.overflow],
      },
    };
  });
}

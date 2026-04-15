/**
 * Field preparation pipeline.
 *
 * Combines in order:
 *   - Story 12.3: BP hint injection
 *   - Label enrichment (cost/fit/recommended metadata)
 *   - Story 21.3: category smart-filter (workload-aware reordering)
 *   - Story 21.4: option ranking for enums with >10 choices
 *   - Story 10.5: intent-aware default overrides
 *
 * Input: dynamicFields (merged pricing + discovery) + raw advanced fields.
 * Output: final commonFields + advancedFields ready for resolveAllFields().
 *
 * Wave-6c F3: extracted from option-elicitor.ts (SRP).
 */

import type { ResourceField } from "@assignee/core";
import {
  enrichFieldLabels,
  applyCategorySmartFilter,
  applyOptionRanking,
  injectBPHints,
} from "../../utils/wizard-helpers.js";
import {
  applyIntentOverrides,
  type IntentDefaultOverride,
} from "../../utils/intent-defaults.js";
import type { WorkloadProfile } from "../../utils/workload-classifier.js";

export interface PreparedFields {
  commonFields: ResourceField[];
  advancedFields: ResourceField[];
}

export function prepareFields(params: {
  dynamicFields: ResourceField[];
  pluginAdvancedFields: ResourceField[];
  resourceType: string;
  workloadProfile: WorkloadProfile;
  intentOverrides: IntentDefaultOverride[];
}): PreparedFields {
  const {
    dynamicFields,
    pluginAdvancedFields,
    resourceType,
    workloadProfile,
    intentOverrides,
  } = params;

  const bpHintedCommon = injectBPHints(dynamicFields, resourceType);
  const bpHintedAdvanced = injectBPHints(pluginAdvancedFields, resourceType);

  const enrichedCommon = enrichFieldLabels(bpHintedCommon);
  const enrichedAdvanced = enrichFieldLabels(bpHintedAdvanced);

  const categoryFilteredCommon = applyCategorySmartFilter(
    enrichedCommon,
    workloadProfile,
  );
  const rankedCommon = applyOptionRanking(
    categoryFilteredCommon,
    workloadProfile,
  );

  const commonFields = applyIntentOverrides(rankedCommon, intentOverrides);
  const advancedFields = applyIntentOverrides(
    enrichedAdvanced,
    intentOverrides,
  );

  return { commonFields, advancedFields };
}

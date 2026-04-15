/**
 * option_elicitor orchestrator.
 *
 * Pipeline:
 *   0. Early exits: compound, non-pending, --no-wizard expert path, non-TTY.
 *   1. Load user/project/org configs in parallel (Story 27.4).
 *   2. Parallel fan-out: pricing + dynamic fields + instance-type discovery
 *      + workload classification (Story 9.10, 21.1).
 *   3. Field preparation: BP hints → label enrichment → smart-filter →
 *      option-ranking → intent overrides.
 *   4. Config resolution (6-level precedence).
 *   5. Pattern-memory hint injection + intent bool pre-injection.
 *   6. Prompt loop for common tier, optional advanced tier gate + loop.
 *   7. Post-wizard recommendations + coherence validation.
 *
 * Wave-6c F3: extracted from option-elicitor.ts (SRP).
 */

import {
  ExecutionStatus,
  defaultPluginRegistry,
  type LlmPort,
  type ResolvedFieldConfig,
  type ResourceField,
} from "@assignee/core";
import type { StructuredTool } from "@langchain/core/tools";
import {
  renderAdvancedConfirm,
  startSpinner,
  stopSpinner,
} from "../../utils/display.js";
import { FieldSource } from "../../constants/field-policy.js";
import { loadUserConfig } from "../../config/user-config-loader.js";
import { loadProjectConfig } from "../../config/project-config-loader.js";
import {
  fetchOrgPolicy,
  readAuthToken,
} from "../../config/org-policy-cache.js";
import { getIntentDefaults } from "../../utils/intent-defaults.js";
import { evaluateShowIf } from "../../utils/wizard-helpers.js";
import type { AgentState } from "../../services/graph.js";
import { buildExpertModeOptions } from "./expert-path.js";
import { runParallelEnrichment } from "./parallel-enrichment.js";
import { prepareFields } from "./field-preparation.js";
import { resolveAllFields } from "./config-resolution.js";
import { makePatternHintApplier, runPromptLoop } from "./prompt-loop.js";
import { runPostWizardHooks } from "./post-wizard.js";

export async function optionElicitorNode(
  state: AgentState,
  tools?: StructuredTool[],
  llmClient?: LlmPort,
): Promise<Partial<AgentState>> {
  if (state.resourcePattern) {
    // Compound intent: pattern defaultOptions provide configuration
    return {};
  }
  if (state.executionStatus !== ExecutionStatus.PENDING) return {};

  // --set key=value pre-fills: typed early so all exit paths include them
  const presetElicited: Record<string, unknown> = {};
  if (state.presetFields) {
    for (const [key, val] of Object.entries(state.presetFields)) {
      presetElicited[key] =
        val === "true" ? true : val === "false" ? false : val;
    }
  }

  // Story 42.1: expert mode — auto-decide everything.
  if (state.noWizard) {
    return { elicitedOptions: buildExpertModeOptions(state, presetElicited) };
  }

  // Non-TTY (CI/pipes): skip prompts, include --set values
  if (!process.stdin.isTTY) {
    return { elicitedOptions: { ...presetElicited } };
  }

  stopSpinner();

  const plugin =
    defaultPluginRegistry.get(state.resourceType) ??
    defaultPluginRegistry.get("generic")!;

  // Story 27.4: configs loaded once per invocation (parallel)
  const [userConfig, projectConfig, authToken] = await Promise.all([
    loadUserConfig(),
    loadProjectConfig(),
    readAuthToken(),
  ]);
  const orgPolicy = await fetchOrgPolicy(authToken);

  const { dynamicFields, workloadProfile } = await runParallelEnrichment({
    plugin,
    state,
    tools,
    llmClient,
  });

  const intentOverrides = getIntentDefaults(
    state.userIntent,
    state.resourceType,
  );

  const { commonFields, advancedFields } = prepareFields({
    dynamicFields,
    pluginAdvancedFields: plugin.advancedFields,
    resourceType: state.resourceType,
    workloadProfile,
    intentOverrides,
  });

  // Story 19.5: previousOptions source removed — compound path short-circuits above
  const previousOptions: Record<string, unknown> = {};

  const { resolvedCommon, resolvedAdvanced } = resolveAllFields({
    commonFields,
    advancedFields,
    state,
    configs: { userConfig, projectConfig, orgPolicy },
  });

  // Story 18.12: propagate categoryHint from intent overrides
  for (const override of intentOverrides) {
    if (override.categoryHint) {
      const resolved = resolvedCommon[override.fieldName];
      if (resolved) resolved.categoryHint = override.categoryHint;
    }
  }

  const patternHintedFields = applyPatternMemory({
    previousOptions,
    resolvedCommon,
    resolvedAdvanced,
  });

  const elicitedOptions: Record<string, unknown> = {};

  // Story 10.5: pre-inject boolean toggles from intent (so showIf gates open)
  const commonFieldNames = new Set(commonFields.map((f) => f.name));
  for (const override of intentOverrides) {
    if (
      (override.value === true || override.value === false) &&
      commonFieldNames.has(override.fieldName)
    ) {
      elicitedOptions[override.fieldName] = override.value;
    }
  }

  const applyPatternHint = makePatternHintApplier(patternHintedFields);

  // Common tier
  await runPromptLoop({
    fields: commonFields.map(applyPatternHint),
    resolved: resolvedCommon,
    elicitedOptions,
    resourceType: state.resourceType,
    tools: tools ?? [],
    llmClient,
    userIntent: state.userIntent,
    progressLabel: "Step",
  });

  // Advanced tier (gated)
  if (advancedFields.length > 0) {
    await runAdvancedTier({
      advancedFields,
      resolvedAdvanced,
      elicitedOptions,
      applyPatternHint,
      state,
      tools,
      llmClient,
    });
  }

  runPostWizardHooks({
    elicitedOptions,
    userIntent: state.userIntent,
    resourceType: state.resourceType,
    runId: state.runId,
  });

  startSpinner("Generating your plan...");

  return { elicitedOptions };
}

/**
 * Story 19.5: apply pattern memory defaults where source is still plugin-default.
 * Returns the set of field names that received a pattern-memory value so the
 * UI can tag them with "(from previous use)".
 */
function applyPatternMemory(params: {
  previousOptions: Record<string, unknown>;
  resolvedCommon: Record<string, ResolvedFieldConfig>;
  resolvedAdvanced: Record<string, ResolvedFieldConfig>;
}): Set<string> {
  const hinted = new Set<string>();
  const { previousOptions, resolvedCommon, resolvedAdvanced } = params;
  for (const [fieldName, resolved] of Object.entries(resolvedCommon)) {
    if (
      fieldName in previousOptions &&
      resolved.source === FieldSource.PLUGIN_DEFAULT
    ) {
      resolved.value = previousOptions[fieldName];
      hinted.add(fieldName);
    }
  }
  for (const [fieldName, resolved] of Object.entries(resolvedAdvanced)) {
    if (
      fieldName in previousOptions &&
      resolved.source === FieldSource.PLUGIN_DEFAULT
    ) {
      resolved.value = previousOptions[fieldName];
      hinted.add(fieldName);
    }
  }
  return hinted;
}

/**
 * Story 41.2: advanced tier gate.
 * If user skips advanced, apply secure defaults (initialValue) for every
 * showIf-visible advanced field. Otherwise run the prompt loop.
 */
async function runAdvancedTier(params: {
  advancedFields: ResourceField[];
  resolvedAdvanced: Record<string, ResolvedFieldConfig>;
  elicitedOptions: Record<string, unknown>;
  applyPatternHint: (f: ResourceField) => ResourceField;
  state: AgentState;
  tools: StructuredTool[] | undefined;
  llmClient: LlmPort | undefined;
}): Promise<void> {
  const {
    advancedFields,
    resolvedAdvanced,
    elicitedOptions,
    applyPatternHint,
    state,
    tools,
    llmClient,
  } = params;

  const showAdvanced = await renderAdvancedConfirm();
  if (!showAdvanced) {
    for (const field of advancedFields) {
      if (
        field.question.showIf &&
        !evaluateShowIf(field.question.showIf, elicitedOptions)
      )
        continue;
      const iv = field.question.initialValue;
      if (iv !== undefined && elicitedOptions[field.name] === undefined) {
        elicitedOptions[field.name] = iv;
      }
    }
    return;
  }

  await runPromptLoop({
    fields: advancedFields.map(applyPatternHint),
    resolved: resolvedAdvanced,
    elicitedOptions,
    resourceType: state.resourceType,
    tools: tools ?? [],
    llmClient,
    userIntent: state.userIntent,
    progressLabel: "Advanced step",
  });
}

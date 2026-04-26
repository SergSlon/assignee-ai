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
 *   6. Wizard passes (common + advanced tier) via runWizardPasses,
 *      with an optional --quick-override replay pass.
 *   7. Post-wizard recommendations + coherence validation.
 *
 * Wave-6c F3: extracted from option-elicitor.ts (SRP).
 * Story 56-it2-03b: wizard passes extracted to wizard-passes.ts.
 */

import { ExecutionStatus } from "@/schema/graph-state.js";
import { defaultPluginRegistry } from "@/resource-plugins/index.js";
import type { LlmPort } from "@/ports/llm-port.js";
import type { ResolvedFieldConfig } from "@/config/resource-policy.js";
import type { ResourceField } from "@/resource-plugins/types.js";
import type { IntentDefaultOverride } from "@/utils/intent-defaults/types.js";
import type { StructuredTool } from "@langchain/core/tools";
import * as clack from "@clack/prompts";
import { startSpinner, stopSpinner } from "@/utils/display.js";
import { UserCancelledError } from "@/errors.js";
import { UserMessage } from "@/config/constants/ui.js";
import { FieldSource } from "@/constants/field-policy.js";
import { loadUserConfig } from "@/config/user-config-loader.js";
import { loadProjectConfig } from "@/config/project-config-loader.js";
import { fetchOrgPolicy, readAuthToken } from "@/config/org-policy-cache.js";
import { getIntentDefaults } from "@/utils/intent-defaults/index.js";
import type { AgentState } from "../../graph-state.js";
import { buildExpertModeOptions } from "./expert-path.js";
import { runParallelEnrichment } from "./parallel-enrichment.js";
import { prepareFields } from "./field-preparation.js";
import { resolveAllFields } from "./config-resolution.js";
import { makePatternHintApplier } from "./prompt-loop.js";
import { runPostWizardHooks } from "./post-wizard.js";
import { runWizardPasses } from "./wizard-passes.js";

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

  // Non-TTY (CI/pipes): skip prompts, include --set values AND the
  // intent-parser's earlier writes (e.g. SecurityGroupIngress array, per
  // Epic 94 R3 / B-01 regression fix). Without this merge, array/object
  // assertions produced by `extractSgIngress` / `extractAssertedValues`
  // are silently discarded in non-TTY runs — every SG ingest collapses
  // to plugin defaults.
  if (!process.stdin.isTTY) {
    return {
      elicitedOptions: { ...(state.elicitedOptions ?? {}), ...presetElicited },
    };
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

  applyCategoryHints(intentOverrides, resolvedCommon);

  const patternHintedFields = applyPatternMemory({
    previousOptions,
    resolvedCommon,
    resolvedAdvanced,
  });

  const elicitedOptions = preInjectIntentBooleans(
    intentOverrides,
    commonFields,
  );

  const applyPatternHint = makePatternHintApplier(patternHintedFields);

  const passParams = {
    commonFields,
    advancedFields,
    resolvedCommon,
    resolvedAdvanced,
    elicitedOptions,
    applyPatternHint,
    state,
    tools,
    llmClient,
  };

  // Initial wizard pass (quickMode mirrors CLI flag).
  // Story 50-2: --quick auto-declines the advanced confirm and applies
  // secure defaults (same as answering "No" to "Configure advanced
  // options?"). The user never sees the advanced prompt chain here.
  const quickMode = state.quickMode === true;
  const { common: commonStats, advanced: advancedStats } =
    await runWizardPasses(passParams, { quickMode });

  runPostWizardHooks({
    elicitedOptions,
    userIntent: state.userIntent,
    resourceType: state.resourceType,
    runId: state.runId,
  });

  // Story 50-2: --quick summary + optional override replay (full wizard).
  if (quickMode && process.stdin.isTTY) {
    await maybeRunQuickOverrideReplay(passParams, commonStats, advancedStats);
  }

  startSpinner("Generating your plan...");

  return { elicitedOptions };
}

/**
 * Story 50-2: --quick summary + single override gate.
 * Message: "[--quick] Used N defaults. Type 'no' to override."
 * Non-TTY: never reached (caller guards on process.stdin.isTTY).
 */
async function promptQuickModeOverride(
  skipped: number,
  prompted: number,
): Promise<boolean> {
  const detail =
    prompted > 0
      ? `Used ${skipped} default${skipped === 1 ? "" : "s"} (prompted for ${prompted} required field${prompted === 1 ? "" : "s"}).`
      : `Used ${skipped} default${skipped === 1 ? "" : "s"}.`;
  const result = await clack.confirm({
    message: `[--quick] ${detail} Proceed with these values?`,
    initialValue: true,
  });
  if (clack.isCancel(result)) {
    clack.cancel(UserMessage.CANCELLED);
    throw new UserCancelledError();
  }
  // result === true  → proceed (no override)
  // result === false → override (drop into full wizard)
  return result === false;
}

/**
 * Story 50-2 replay: if any field was skipped/prompted under --quick, offer
 * the user a single gate to re-run the full wizard. The replay re-uses the
 * same wizard passes with quickMode=false; fields already answered stay,
 * so the user is only re-prompted for fields that --quick defaulted.
 */
async function maybeRunQuickOverrideReplay(
  passParams: Parameters<typeof runWizardPasses>[0],
  commonStats: { skippedByDefault: number; promptedCount: number },
  advancedStats: { skippedByDefault: number; promptedCount: number },
): Promise<void> {
  const totalSkipped =
    commonStats.skippedByDefault + advancedStats.skippedByDefault;
  const totalPrompted = commonStats.promptedCount + advancedStats.promptedCount;
  if (totalSkipped === 0 && totalPrompted === 0) return;
  const override = await promptQuickModeOverride(totalSkipped, totalPrompted);
  if (override) {
    await runWizardPasses(passParams, { quickMode: false });
  }
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
 * Story 18.12: propagate categoryHint from intent overrides into the
 * already-resolved common-field config so the UI can group options
 * (e.g. "recommended for this intent") when rendering.
 */
function applyCategoryHints(
  intentOverrides: IntentDefaultOverride[],
  resolvedCommon: Record<string, ResolvedFieldConfig>,
): void {
  for (const override of intentOverrides) {
    if (override.categoryHint) {
      const resolved = resolvedCommon[override.fieldName];
      if (resolved) resolved.categoryHint = override.categoryHint;
    }
  }
}

/**
 * Story 10.5: pre-inject boolean toggles from intent so showIf gates on
 * dependent fields open without a manual prompt.
 *
 * Also pre-injects `autoProvision` fields (e.g. EC2 SSH KeyName) so the
 * ASK_IF_NOT_SET gate in applyFieldGates sees a value and skips the prompt
 * entirely. The provisioner receives the value at apply time and handles the
 * actual resource creation (e.g. ssh-keypair.ts for KeyName placeholder).
 * Users can still override via `--set fieldName=value` — presetFields are
 * injected earlier (applyPresetFields) and overwrite this map.
 *
 * Returns a fresh elicitedOptions map seeded with those values.
 */
function preInjectIntentBooleans(
  intentOverrides: IntentDefaultOverride[],
  commonFields: ResourceField[],
): Record<string, unknown> {
  const commonFieldNames = new Set(commonFields.map((f) => f.name));
  const elicitedOptions: Record<string, unknown> = {};
  for (const override of intentOverrides) {
    if (!commonFieldNames.has(override.fieldName)) continue;
    if (override.value === true || override.value === false) {
      elicitedOptions[override.fieldName] = override.value;
    } else if (override.autoProvision === true) {
      // Pre-inject auto-provision sentinels (strings/objects) so the
      // ASK_IF_NOT_SET gate skips the prompt. The provisioner consumes
      // the sentinel value at apply time.
      elicitedOptions[override.fieldName] = override.value;
    }
  }
  return elicitedOptions;
}

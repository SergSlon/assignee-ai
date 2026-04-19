/**
 * Wizard passes helper — common tier + advanced tier gate.
 * Extracted from orchestrator.ts (Story 56-it2-03b): the initial pass
 * and the --quick-override replay now share a single parameterised
 * entry point. Stats flow back for the --quick summary line.
 */

import type { LlmPort } from "../../../ports/llm-port.js";
import type { ResolvedFieldConfig } from "../../../config/resource-policy.js";
import type { ResourceField } from "../../../resource-plugins/types.js";
import type { StructuredTool } from "@langchain/core/tools";
import { renderAdvancedConfirm } from "../../../utils/display.js";
import { evaluateShowIf } from "../../../utils/wizard-helpers.js";
import type { AgentState } from "../../graph-state.js";
import { runPromptLoop } from "./prompt-loop.js";

export interface WizardPassStats {
  skippedByDefault: number;
  promptedCount: number;
}

export interface WizardPassesResult {
  common: WizardPassStats;
  advanced: WizardPassStats;
}

export interface RunWizardPassesParams {
  commonFields: ResourceField[];
  advancedFields: ResourceField[];
  resolvedCommon: Record<string, ResolvedFieldConfig>;
  resolvedAdvanced: Record<string, ResolvedFieldConfig>;
  elicitedOptions: Record<string, unknown>;
  applyPatternHint: (f: ResourceField) => ResourceField;
  state: AgentState;
  tools: StructuredTool[] | undefined;
  llmClient: LlmPort | undefined;
}

export interface RunWizardPassesOptions {
  quickMode: boolean;
}

/** Runs the common-tier loop then the advanced-tier gate; returns per-tier stats. */
export async function runWizardPasses(
  params: RunWizardPassesParams,
  options: RunWizardPassesOptions,
): Promise<WizardPassesResult> {
  const { quickMode } = options;

  const common = await runPromptLoop({
    fields: params.commonFields.map(params.applyPatternHint),
    resolved: params.resolvedCommon,
    elicitedOptions: params.elicitedOptions,
    resourceType: params.state.resourceType,
    tools: params.tools ?? [],
    llmClient: params.llmClient,
    userIntent: params.state.userIntent,
    progressLabel: "Step",
    quickMode,
  });

  const advanced: WizardPassStats =
    params.advancedFields.length > 0
      ? await runAdvancedTier(params, quickMode)
      : { skippedByDefault: 0, promptedCount: 0 };

  return { common, advanced };
}

/**
 * Story 41.2 / 50-2: advanced tier gate.
 * Non-quick → ask the user; declined → apply secure defaults (initialValue)
 * for every showIf-visible advanced field. Accepted → prompt loop.
 * Quick → auto-decline (secure defaults applied silently).
 */
async function runAdvancedTier(
  params: RunWizardPassesParams,
  quickMode: boolean,
): Promise<WizardPassStats> {
  const showAdvanced = quickMode ? false : await renderAdvancedConfirm();
  if (!showAdvanced) {
    return applyAdvancedDefaults(params);
  }
  return runPromptLoop({
    fields: params.advancedFields.map(params.applyPatternHint),
    resolved: params.resolvedAdvanced,
    elicitedOptions: params.elicitedOptions,
    resourceType: params.state.resourceType,
    tools: params.tools ?? [],
    llmClient: params.llmClient,
    userIntent: params.state.userIntent,
    progressLabel: "Advanced step",
    quickMode,
  });
}

/**
 * Apply secure defaults (initialValue) for every showIf-visible advanced
 * field that has not already been set. Returns stats for the summary line.
 */
function applyAdvancedDefaults(params: RunWizardPassesParams): WizardPassStats {
  const { advancedFields, elicitedOptions } = params;
  let skipped = 0;
  for (const field of advancedFields) {
    if (
      field.question.showIf &&
      !evaluateShowIf(field.question.showIf, elicitedOptions)
    )
      continue;
    const iv = field.question.initialValue;
    if (iv !== undefined && elicitedOptions[field.name] === undefined) {
      elicitedOptions[field.name] = iv;
      skipped++;
    }
  }
  return { skippedByDefault: skipped, promptedCount: 0 };
}

/**
 * option_elicitor node — interactively collects resource configuration from the user
 * before plan generation, using the ResourcePlugin field definitions from Story 7.1.
 *
 * Live pricing: fetches real-time on-demand prices from the AWS Pricing API MCP server
 * before the prompt loop and injects them into enum option labels.
 *
 * Config integration: loads user config, project config, and org policy in parallel,
 * then uses mergeConfigs() to resolve field values/policies via 6-level precedence.
 * Fields resolved as never_ask are injected silently; ask_if_not_set pre-fills
 * initialValue; always_ask forces a prompt regardless of config.
 *
 * @see Story 7.3, Story 27.4
 */

import * as clack from "@clack/prompts";
import {
  ExecutionStatus,
  RESOURCE_TYPES,
  defaultPluginRegistry,
  MissingRequiredFieldsError,
  CfnKey,
  QuestionTypeName,
} from "@assignee/core";
import { log, LOG_ACTIONS } from "../utils/logger.js";
import type { ResourceField } from "@assignee/core";
import type { StructuredTool } from "@langchain/core/tools";
import type { LlmPort } from "@assignee/core";
import {
  renderAdvancedConfirm,
  startSpinner,
  stopSpinner,
  BACK_SENTINEL,
} from "../utils/display.js";
import {
  discoverInstanceTypes,
  type InstanceTypeCategory,
} from "../utils/aws-resource-discovery.js";
import { FieldPolicy, FieldSource } from "../constants/field-policy.js";
import { PromiseStatus } from "../config/constants.js";
import { loadUserConfig } from "../config/user-config-loader.js";
import { loadProjectConfig } from "../config/project-config-loader.js";
import { fetchOrgPolicy, readAuthToken } from "../config/org-policy-cache.js";
import {
  mergeConfigs,
  type MergeConfigsInput,
} from "../utils/merge-configs.js";
import {
  evaluateWizardRecommendations,
  displayRecommendations,
} from "../utils/wizard-recommendations.js";
import { validateCoherence } from "../utils/coherence-validator.js";
import {
  getIntentDefaults,
  applyIntentOverrides,
} from "../utils/intent-defaults.js";
import {
  classifyWorkload,
  type WorkloadProfile,
} from "../utils/workload-classifier.js";
import { WorkloadProfile as WP } from "../constants/workload-profiles.js";
import type { AgentState } from "../services/graph.js";

// ── Re-export helpers for backward compatibility ──────────────────────────────
// All existing exports must remain accessible from this module.

export {
  fieldFetchKey,
  evaluateShowIf,
  populateDefaultOptions,
  enrichFieldLabels,
  applyCategorySmartFilter,
  applyOptionRanking,
  getDiscoverySpinnerMessage,
  resolveDynamicFields,
  fetchPricesForResource,
  injectPriceLabels,
  enrichWithLivePricing,
  mergeEnrichedFields,
  injectBPHints,
  fetchSuggestionPrice,
  promptWithHelp,
} from "../utils/wizard-helpers.js";

export { resolveFieldConfigs } from "../utils/field-resolver.js";

// ── Internal imports from extracted modules ───────────────────────────────────

import {
  fieldFetchKey,
  evaluateShowIf,
  populateDefaultOptions,
  enrichFieldLabels,
  applyCategorySmartFilter,
  applyOptionRanking,
  getDiscoverySpinnerMessage,
  resolveDynamicFields,
  enrichWithLivePricing,
  mergeEnrichedFields,
  injectBPHints,
  promptWithHelp,
} from "../utils/wizard-helpers.js";

export async function optionElicitorNode(
  state: AgentState,
  tools?: StructuredTool[],
  llmClient?: LlmPort,
): Promise<Partial<AgentState>> {
  if (state.resourcePattern) {
    // Compound intent: elicitation skipped — pattern defaultOptions provide configuration
    return {};
  }

  if (state.executionStatus !== ExecutionStatus.PENDING) return {};

  // --set key=value pre-fills: parse into typed values early so all exit paths include them
  const presetElicited: Record<string, unknown> = {};
  if (state.presetFields) {
    for (const [key, val] of Object.entries(state.presetFields)) {
      presetElicited[key] =
        val === "true" ? true : val === "false" ? false : val;
    }
  }

  // Story 42.1: Expert mode (default) — auto-decide everything using plugin defaults + intent analysis.
  // The wizard is opt-in via --wizard. Missing required fields are allowed —
  // the plan-generator LLM will extract them from the user intent.
  if (state.noWizard) {
    const plugin =
      defaultPluginRegistry.get(state.resourceType) ??
      defaultPluginRegistry.get("generic")!;

    // Story 42.3: Merge intent-derived overrides into defaults (SSH → KeyName + PublicIP, etc.)
    const intentOverrides = getIntentDefaults(
      state.userIntent,
      state.resourceType,
    );
    const intentMap = new Map(
      intentOverrides.map((o) => [o.fieldName, o.value]),
    );

    // Build options: plugin defaults + intent overrides + preset (--set) values
    const elicitedOptions: Record<string, unknown> = {};
    const allFields = [...plugin.commonFields, ...plugin.advancedFields];
    for (const field of allFields) {
      if (field.question.showIf) continue;
      // Priority: intent override > initialValue > plugin defaults
      const intentVal = intentMap.get(field.name);
      const iv = field.question.initialValue;
      const pd = plugin.defaults[field.name];
      if (intentVal !== undefined) elicitedOptions[field.name] = intentVal;
      else if (iv !== undefined) elicitedOptions[field.name] = iv;
      else if (pd !== undefined) elicitedOptions[field.name] = pd;
    }

    return { elicitedOptions: { ...elicitedOptions, ...presetElicited } };
  }

  // Non-TTY (CI/pipes): skip all prompts but include --set values
  if (!process.stdin.isTTY) return { elicitedOptions: { ...presetElicited } };

  // Stop the outer "Generating plan..." spinner before interactive prompts
  stopSpinner();

  const plugin =
    defaultPluginRegistry.get(state.resourceType) ??
    defaultPluginRegistry.get("generic")!;

  // Story 27.4: Load user config, project config, and org policy in parallel.
  // These are loaded once per `assignee plan` invocation, not per field.
  const [userConfig, projectConfig, authToken] = await Promise.all([
    loadUserConfig(),
    loadProjectConfig(),
    readAuthToken(),
  ]);
  const orgPolicy = await fetchOrgPolicy(authToken);

  // Story 9.10: Parallel fan-out — pricing enrichment and dynamic field discovery
  // run concurrently. They operate on different fields (pricing → InstanceType labels,
  // discovery → AMI/Subnet/SG/KeyPair options) so results merge without conflict.
  const parallelSpinner = clack.spinner();
  // Story 20.6: Use resource-specific spinner message when fetching dynamic options
  const discoveryMessage = getDiscoverySpinnerMessage(plugin.commonFields);
  const spinnerMessage = discoveryMessage ?? "Preparing your wizard\u2026";
  parallelSpinner.start(spinnerMessage);

  // Story 21.1: Classify workload profile in parallel with pricing/discovery.
  // Result stored for Story 21.2 (smart option filtering).
  let workloadProfile: WorkloadProfile = WP.UNKNOWN;

  const startMs = Date.now();
  const [
    pricingSettled,
    discoverySettled,
    instanceTypesSettled,
    classificationSettled,
  ] = await Promise.allSettled([
    tools && tools.length > 0
      ? enrichWithLivePricing(plugin, tools)
      : Promise.resolve(plugin.commonFields),
    resolveDynamicFields(plugin.commonFields, {}),
    // Fetch real instance types from AWS for EC2 categorySelect
    state.resourceType === RESOURCE_TYPES.EC2_INSTANCE
      ? discoverInstanceTypes()
      : Promise.resolve(null),
    // Story 21.1: LLM-based workload classification
    llmClient && state.userIntent
      ? classifyWorkload(state.userIntent, llmClient)
      : Promise.resolve(WP.UNKNOWN as WorkloadProfile),
  ]);

  // Story 21.1: Extract classification result
  if (classificationSettled.status === PromiseStatus.FULFILLED) {
    workloadProfile = classificationSettled.value;
  }

  const pricedFields =
    pricingSettled.status === PromiseStatus.FULFILLED
      ? pricingSettled.value
      : plugin.commonFields;

  const discoveredFields =
    discoverySettled.status === PromiseStatus.FULFILLED
      ? discoverySettled.value
      : plugin.commonFields;

  // If real instance types were fetched, replace hardcoded categories on the InstanceType field
  const liveCategories: InstanceTypeCategory[] | null =
    instanceTypesSettled.status === PromiseStatus.FULFILLED
      ? (instanceTypesSettled.value as InstanceTypeCategory[] | null)
      : null;

  // Merge: pricing-enriched labels + discovery-resolved options
  let dynamicFields = mergeEnrichedFields(pricedFields, discoveredFields);

  // Replace hardcoded categorySelect categories with live data if available
  if (liveCategories && liveCategories.length > 0) {
    dynamicFields = dynamicFields.map((field) => {
      if (
        field.name !== CfnKey.INSTANCE_TYPE ||
        field.question.type !== QuestionTypeName.CATEGORY_SELECT
      )
        return field;
      return {
        ...field,
        question: {
          ...field.question,
          categories: liveCategories,
        },
      };
    });
  }

  log({
    ts: new Date().toISOString(),
    runId: state.runId,
    level: "info",
    action: LOG_ACTIONS.OPTION_ELICITED,
    extras: {
      parallelFanOutMs: Date.now() - startMs,
      pricingStatus: pricingSettled.status,
      discoveryStatus: discoverySettled.status,
      workloadProfile,
    },
  });

  parallelSpinner.stop("Ready");

  // Story 12.3: Inject BP-sourced hints into field prompts
  const bpHintedCommon = injectBPHints(dynamicFields, state.resourceType);
  const bpHintedAdvanced = injectBPHints(
    plugin.advancedFields,
    state.resourceType,
  );

  // Enrich with contextual metadata (cost/fit/recommended) from plugin definitions
  const enrichedCommon = enrichFieldLabels(bpHintedCommon);

  // Enrich advanced fields with contextual metadata too
  const enrichedAdvanced = enrichFieldLabels(bpHintedAdvanced);

  // Story 21.3: Smart-filter categorySelect fields (EC2 InstanceType) by workload profile.
  // Reorders categories so the matching one appears first, ranks within-category options.
  const categoryFilteredCommon = applyCategorySmartFilter(
    enrichedCommon,
    workloadProfile,
  );

  // Story 21.4: Rank enum fields with many options (>10) by workload relevance.
  // Applied after enrichment so labels are already finalized.
  const rankedCommon = applyOptionRanking(
    categoryFilteredCommon,
    workloadProfile,
  );

  // Story 10.5: Apply intent-aware smart defaults — higher priority than plugin
  // initialValue, lower priority than pattern memory and user input.
  const intentOverrides = getIntentDefaults(
    state.userIntent,
    state.resourceType,
  );
  const commonFields = applyIntentOverrides(rankedCommon, intentOverrides);
  const advancedFields = applyIntentOverrides(
    enrichedAdvanced,
    intentOverrides,
  );

  // Story 19.5: Pattern memory block removed — compound intents (resourcePattern set)
  // return early at line 543, so this code was unreachable dead code.
  const previousOptions: Record<string, unknown> = {};

  // Story 27.4: Build config-aware merge input for 6-level precedence resolution.
  // Extract global defaults (region, tags, naming prefix) from resolved config
  // and inject them into a synthetic layer so they apply across all plugin fields.
  const configDefaults: Record<string, unknown> = {};
  const resolvedConfig = projectConfig ?? userConfig;
  if (resolvedConfig?.defaults?.region) {
    configDefaults[CfnKey.REGION] = resolvedConfig.defaults.region;
  }
  if (resolvedConfig?.defaults?.tags) {
    configDefaults[CfnKey.TAGS] = resolvedConfig.defaults.tags;
  }

  // Convert UserResourceConfig-shaped configs to the format mergeConfigs expects.
  // mergeConfigs looks up fields by resourceType key in the config objects.
  const userConfigAsResource = userConfig
    ? {
        [state.resourceType]: {
          ...configDefaults,
          ...(
            userConfig as unknown as Record<string, Record<string, unknown>>
          )?.[state.resourceType],
        },
      }
    : undefined;

  const projectConfigAsResource = projectConfig
    ? {
        [state.resourceType]: {
          ...(projectConfig.defaults?.region
            ? { region: projectConfig.defaults.region }
            : {}),
          ...(projectConfig.defaults?.tags
            ? { Tags: projectConfig.defaults.tags }
            : {}),
          ...(
            projectConfig as unknown as Record<string, Record<string, unknown>>
          )?.[state.resourceType],
        },
      }
    : undefined;

  // Resolve field configs using mergeConfigs, re-keyed by fieldFetchKey
  // so showIf-variant fields (e.g., multiple EngineVersion per engine) are preserved.
  const resolveFieldsWithConfig = (fields: ResourceField[]) => {
    const mergeInput: MergeConfigsInput = {
      pluginFields: fields,
      resourceType: state.resourceType,
      orgPolicy: orgPolicy,
      userConfig: userConfigAsResource,
      projectConfig: projectConfigAsResource,
    };
    const raw = mergeConfigs(mergeInput);
    // Re-key from field.name to fieldFetchKey for disambiguation
    const result: Record<string, import("@assignee/core").ResolvedFieldConfig> =
      {};
    for (const field of fields) {
      const key = fieldFetchKey(field);
      const resolved = raw[field.name];
      if (resolved) {
        result[key] = { ...resolved };
      }
    }
    return result;
  };

  const resolvedCommon = resolveFieldsWithConfig(commonFields);
  const resolvedAdvanced = resolveFieldsWithConfig(advancedFields);

  // Pre-fill the primary name field from user intent (e.g., "named poc-smoke-test")
  if (state.userIntent) {
    const nameMatch = state.userIntent.match(/\bnamed?\s+([^\s,]+)/i);
    if (nameMatch?.[1]) {
      // The first commonField is typically the resource name (required or not)
      const nameField = commonFields[0];
      if (nameField) {
        const key = fieldFetchKey(nameField);
        if (resolvedCommon[key] && !resolvedCommon[key]!.value) {
          resolvedCommon[key] = {
            ...resolvedCommon[key]!,
            value: nameMatch[1],
            source: FieldSource.PLUGIN_DEFAULT,
          };
        }
      }
    }
  }

  // --set key=value pre-fills: inject into resolved configs as NEVER_ASK
  if (state.presetFields) {
    for (const [fieldName, value] of Object.entries(state.presetFields)) {
      // Check common fields
      const commonKey = fieldName;
      if (resolvedCommon[commonKey]) {
        resolvedCommon[commonKey] = {
          policy: FieldPolicy.NEVER_ASK,
          value: value === "true" ? true : value === "false" ? false : value,
          source: FieldSource.PLUGIN_DEFAULT,
        };
      }
      // Check advanced fields
      if (resolvedAdvanced[commonKey]) {
        resolvedAdvanced[commonKey] = {
          policy: FieldPolicy.NEVER_ASK,
          value: value === "true" ? true : value === "false" ? false : value,
          source: FieldSource.PLUGIN_DEFAULT,
        };
      }
    }
  }

  // Story 27.4: Log resolved field sources for diagnostics
  if (state.runId) {
    for (const [fieldName, resolved] of Object.entries(resolvedCommon)) {
      if (resolved.source !== FieldSource.PLUGIN_DEFAULT) {
        log({
          ts: new Date().toISOString(),
          runId: state.runId,
          level: "info",
          action: LOG_ACTIONS.CONFIG_LOADED,
          extras: {
            field: fieldName,
            value: resolved.value,
            source: resolved.source,
            policy: resolved.policy,
          },
        });
      }
    }
  }

  // Story 18.12: Propagate categoryHint from intent overrides into resolved configs
  for (const override of intentOverrides) {
    if (override.categoryHint) {
      const resolved = resolvedCommon[override.fieldName];
      if (resolved) {
        resolved.categoryHint = override.categoryHint;
      }
    }
  }

  // Story 19.5: Apply pattern memory defaults — higher priority than plugin defaults,
  // lower priority than org policy locks. User can still override during prompt.
  const patternHintedFields = new Set<string>();
  for (const [fieldName, resolved] of Object.entries(resolvedCommon)) {
    if (
      fieldName in previousOptions &&
      resolved.source === FieldSource.PLUGIN_DEFAULT
    ) {
      resolved.value = previousOptions[fieldName];
      patternHintedFields.add(fieldName);
    }
  }
  for (const [fieldName, resolved] of Object.entries(resolvedAdvanced)) {
    if (
      fieldName in previousOptions &&
      resolved.source === FieldSource.PLUGIN_DEFAULT
    ) {
      resolved.value = previousOptions[fieldName];
      patternHintedFields.add(fieldName);
    }
  }

  const elicitedOptions: Record<string, unknown> = {};

  // Story 10.5: Pre-inject boolean toggles from intent overrides so showIf gates
  // open for child fields (e.g., EnableLifecycle=true reveals LifecycleTransitionDays).
  // Only pre-inject for commonFields — advanced field toggles require user confirmation.
  const commonFieldNames = new Set(commonFields.map((f) => f.name));
  for (const override of intentOverrides) {
    if (
      (override.value === true || override.value === false) &&
      commonFieldNames.has(override.fieldName)
    ) {
      elicitedOptions[override.fieldName] = override.value;
    }
  }

  // Story 19.5: Append "(from previous use)" hint to pattern-memory-defaulted fields
  const applyPatternHint = (field: ResourceField): ResourceField => {
    if (!patternHintedFields.has(field.name)) return field;
    const patternHint = "(from previous use)";
    const existingHint = field.question.hint;
    return {
      ...field,
      question: {
        ...field.question,
        hint: existingHint ? `${existingHint}\n${patternHint}` : patternHint,
      },
    };
  };

  // ── Common tier (with back navigation) ─────────────────────────────────────
  const hintedCommon = commonFields.map(applyPatternHint);
  const commonHistory: number[] = []; // Stack of visited field indices

  // Count only visible askable fields (exclude showIf fields whose condition is not met)
  const countVisibleCommon = () =>
    hintedCommon.filter((f) => {
      const res = resolvedCommon[fieldFetchKey(f)];
      if (!res) return false;
      if (res.policy === FieldPolicy.NEVER_ASK) return false;
      if (
        f.question.showIf &&
        !evaluateShowIf(f.question.showIf, elicitedOptions)
      )
        return false;
      return true;
    }).length;
  let totalCommon = countVisibleCommon();

  let ci = 0;
  let visibleIndex = 0;
  while (ci < hintedCommon.length) {
    const field = hintedCommon[ci]!;
    const resolved = resolvedCommon[fieldFetchKey(field)];
    if (!resolved) {
      ci++;
      continue;
    }

    // showIf conditional — skip if condition not met
    if (field.question.showIf) {
      if (!evaluateShowIf(field.question.showIf, elicitedOptions)) {
        ci++;
        continue;
      }
    }

    if (resolved.policy === FieldPolicy.NEVER_ASK) {
      if (resolved.value !== undefined)
        elicitedOptions[field.name] = resolved.value;
      ci++;
      continue;
    }

    if (resolved.policy === FieldPolicy.ASK_IF_NOT_SET) {
      if (elicitedOptions[field.name] !== undefined) {
        ci++;
        continue;
      }
    }

    // Progress indicator (TTY only, common fields only)
    const clampedCommonIndex = Math.min(visibleIndex, totalCommon - 1);
    if (process.stdout.isTTY && totalCommon > 1) {
      clack.log.info(`Step ${clampedCommonIndex + 1} of ${totalCommon}`);
    }

    const answer = await promptWithHelp(
      field,
      resolved,
      state.resourceType,
      tools ?? [],
      llmClient,
      state.userIntent,
      commonHistory.length > 0, // show back if not the first visible field
      elicitedOptions,
    );

    if (answer === BACK_SENTINEL) {
      // Go back to previous visible field
      const prevIndex = commonHistory.pop();
      if (prevIndex !== undefined) {
        const prevField = hintedCommon[prevIndex]!;
        // Delete the current field's answer too (not just prev)
        delete elicitedOptions[field.name];
        delete elicitedOptions[prevField.name];
        // Clean up showIf-dependent values that depended on the reverted field
        for (const f of hintedCommon) {
          if (f.question.showIf?.field === prevField.name) {
            delete elicitedOptions[f.name];
          }
        }
        ci = prevIndex;
        if (visibleIndex > 0) visibleIndex--;
      }
      continue;
    }

    commonHistory.push(ci);
    if (answer !== undefined && answer !== "") {
      elicitedOptions[field.name] = answer;
    }
    totalCommon = countVisibleCommon();
    visibleIndex++;
    ci++;
  }

  // ── Advanced tier gate ───────────────────────────────────────────────────────
  if (advancedFields.length > 0) {
    const showAdvanced = await renderAdvancedConfirm();
    if (!showAdvanced) {
      // Story 41.2: Apply secure defaults for all advanced fields when skipped
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
    }
    if (showAdvanced) {
      const hintedAdvanced = advancedFields.map(applyPatternHint);
      const advHistory: number[] = [];

      // Count only visible askable advanced fields (exclude hidden showIf fields)
      const countVisibleAdv = () =>
        hintedAdvanced.filter((f) => {
          const res = resolvedAdvanced[fieldFetchKey(f)];
          if (!res) return false;
          if (res.policy === FieldPolicy.NEVER_ASK) return false;
          if (
            f.question.showIf &&
            !evaluateShowIf(f.question.showIf, elicitedOptions)
          )
            return false;
          return true;
        }).length;
      let totalAdv = countVisibleAdv();

      let ai = 0;
      let advVisibleIndex = 0;
      while (ai < hintedAdvanced.length) {
        const field = hintedAdvanced[ai]!;
        const resolved = resolvedAdvanced[fieldFetchKey(field)];
        if (!resolved) {
          ai++;
          continue;
        }

        if (field.question.showIf) {
          if (!evaluateShowIf(field.question.showIf, elicitedOptions)) {
            ai++;
            continue;
          }
        }

        if (resolved.policy === FieldPolicy.NEVER_ASK) {
          if (resolved.value !== undefined)
            elicitedOptions[field.name] = resolved.value;
          ai++;
          continue;
        }

        // Progress indicator (TTY only, advanced fields)
        const clampedAdvIndex = Math.min(advVisibleIndex, totalAdv - 1);
        if (process.stdout.isTTY && totalAdv > 1) {
          clack.log.info(`Advanced step ${clampedAdvIndex + 1} of ${totalAdv}`);
        }

        const answer = await promptWithHelp(
          field,
          resolved,
          state.resourceType,
          tools ?? [],
          llmClient,
          state.userIntent,
          advHistory.length > 0,
          elicitedOptions,
        );

        if (answer === BACK_SENTINEL) {
          const prevIndex = advHistory.pop();
          if (prevIndex !== undefined) {
            const prevField = hintedAdvanced[prevIndex]!;
            delete elicitedOptions[field.name];
            delete elicitedOptions[prevField.name];
            for (const f of hintedAdvanced) {
              if (f.question.showIf?.field === prevField.name) {
                delete elicitedOptions[f.name];
              }
            }
            ai = prevIndex;
            if (advVisibleIndex > 0) advVisibleIndex--;
          }
          continue;
        }

        advHistory.push(ai);
        if (answer !== undefined && answer !== "") {
          elicitedOptions[field.name] = answer;
        }
        totalAdv = countVisibleAdv();
        advVisibleIndex++;
        ai++;
      }
    }
  }

  // ── Post-wizard recommendations (Story 10.7) ─────────────────────────────
  const recommendations = evaluateWizardRecommendations(
    elicitedOptions,
    state.userIntent ?? "",
    state.resourceType,
  );
  displayRecommendations(recommendations);

  // ── Coherence validation (Story 41.5) ────────────────────────────────────
  const coherenceWarnings = validateCoherence(
    elicitedOptions,
    state.userIntent ?? "",
    state.resourceType,
  );
  if (coherenceWarnings.length > 0) {
    for (const w of coherenceWarnings) {
      clack.log.warn(w.message);
    }
  }

  log({
    ts: new Date().toISOString(),
    runId: state.runId,
    level: "info",
    action: LOG_ACTIONS.OPTION_ELICITED,
    extras: {
      resourceType: state.resourceType,
      elicitedKeys: Object.keys(elicitedOptions),
      elicitedValues: Object.fromEntries(
        Object.entries(elicitedOptions).map(([k, v]) => [
          k,
          typeof v === "object" ? "[object]" : String(v),
        ]),
      ),
    },
  });

  startSpinner("Generating your plan...");

  return { elicitedOptions };
}

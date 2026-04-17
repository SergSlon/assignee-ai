/**
 * Parallel enrichment fan-out.
 *
 * Story 9.10: pricing enrichment + dynamic field discovery run
 * concurrently. They operate on different fields (pricing → InstanceType
 * labels, discovery → AMI/Subnet/SG/KeyPair options) so results merge
 * without conflict.
 *
 * Story 21.1: workload classification runs in parallel and its result
 * feeds Story 21.2/21.3 smart option filtering downstream.
 *
 * Wave-6c F3: extracted from option-elicitor.ts (SRP).
 */

import * as clack from "@clack/prompts";
import {
  RESOURCE_TYPES,
  CfnKey,
  QuestionTypeName,
  type ResourceField,
  type ResourcePlugin,
  type LlmPort,
} from "@assignee/core";
import type { StructuredTool } from "@langchain/core/tools";
import { PromiseStatus } from "../../../config/constants/enums.js";
import { log, LOG_ACTIONS } from "../../../utils/logger/index.js";
import {
  discoverInstanceTypes,
  type InstanceTypeCategory,
} from "../../../utils/aws-resource-discovery/index.js";
import {
  classifyWorkload,
  type WorkloadProfile,
} from "../../../utils/workload-classifier.js";
import { WorkloadProfileKey as WP } from "../../../config/cfn-keys/display.js";
import {
  enrichWithLivePricing,
  resolveDynamicFields,
  mergeEnrichedFields,
  getDiscoverySpinnerMessage,
} from "../../../utils/wizard-helpers.js";
import type { AgentState } from "../../graph-state.js";

export interface EnrichmentResult {
  dynamicFields: ResourceField[];
  workloadProfile: WorkloadProfile;
}

export async function runParallelEnrichment(params: {
  plugin: ResourcePlugin;
  state: AgentState;
  tools: StructuredTool[] | undefined;
  llmClient: LlmPort | undefined;
}): Promise<EnrichmentResult> {
  const { plugin, state, tools, llmClient } = params;
  const parallelSpinner = clack.spinner();
  const discoveryMessage = getDiscoverySpinnerMessage(plugin.commonFields);
  const spinnerMessage = discoveryMessage ?? "Preparing your wizard\u2026";
  parallelSpinner.start(spinnerMessage);

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
    state.resourceType === RESOURCE_TYPES.EC2_INSTANCE
      ? discoverInstanceTypes()
      : Promise.resolve(null),
    llmClient && state.userIntent
      ? classifyWorkload(state.userIntent, llmClient)
      : Promise.resolve(WP.UNKNOWN as WorkloadProfile),
  ]);

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

  const liveCategories: InstanceTypeCategory[] | null =
    instanceTypesSettled.status === PromiseStatus.FULFILLED
      ? (instanceTypesSettled.value as InstanceTypeCategory[] | null)
      : null;

  let dynamicFields = mergeEnrichedFields(pricedFields, discoveredFields);

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

  return { dynamicFields, workloadProfile };
}

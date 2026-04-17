/**
 * plan_generator node — calls LLM via LlmPort to produce a CloudFormation
 * desiredState that satisfies the user's intent and conforms to the fetched
 * schema. Compound patterns short-circuit the LLM and use
 * pattern.defaultOptions + completed-resource markers instead.
 *
 * Wave-6 F2: SOLID refactor. This file is now a thin façade over the
 * SRP-aligned sub-modules in `./plan-generator/`. All previously-exported
 * helpers are re-exported here for back-compatibility with existing tests
 * and intra-repo imports (resource-provisioner.ts, graph.ts, etc.).
 *
 * @see Story 1-5, NFR-05 (<3s after MCP up), NFR-15 (1024 max tokens)
 * @see Story 9.5 — LLM client decoupling (M3)
 * @see .agents/stories/wave-6-f2-plan-generator-solid-refactor.md
 */

import type { LlmPort } from "@assignee/core";
import type { AgentState } from "../graph-state.js";
import { runCompoundPlan } from "./plan-generator/compound-plan.js";
import { runLlmPlan } from "./plan-generator/llm-plan.js";
import type { AzLookup } from "./plan-generator/marker-resolver.js";

// ---------------------------------------------------------------------------
// Back-compat re-exports. Downstream code (plan-generator.test.ts,
// plan-generator.safeClone.test.ts, tocfn-exhaustive.test.ts,
// secure-defaults-audit.test.ts, resource-provisioner.ts) imports these
// names from "./plan-generator.js" — the refactor MUST NOT break them.
// ---------------------------------------------------------------------------
export {
  redactResourceId,
  safeCloneDesiredState,
} from "./plan-generator/safe-clone.js";
export {
  applyToCfnTransforms,
  assembleS3Composites,
  assembleEc2Storage,
} from "./plan-generator/cfn-emitter.js";
export {
  isTemplatePlaceholder,
  collectPluginPlaceholders,
  stripPlaceholderArns,
} from "./plan-generator/placeholders.js";
export {
  defaultAzLookup,
  resolveCompoundMarkers,
  __resetAzCacheForTests,
  type AzLookup,
} from "./plan-generator/marker-resolver.js";

/**
 * Factory for the plan_generator LangGraph node. Accepts `llmClient`
 * (LlmPort) and an optional `azLookup` (AzLookup port) via dependency
 * injection — DIP: the node depends on narrow ports, not on concrete
 * adapters. Tests inject fakes.
 *
 * The node body is a single dispatch: compound vs LLM path. All business
 * logic lives in the sub-modules.
 */
export function createPlanGeneratorNode({
  llmClient,
  azLookup,
}: {
  llmClient: LlmPort;
  /** Optional AZ lookup override — used in tests to avoid real EC2 calls. */
  azLookup?: AzLookup;
}) {
  return async function planGeneratorNode(
    state: AgentState,
  ): Promise<Partial<AgentState>> {
    // Compound mode: short-circuit LLM — use pattern defaultOptions instead.
    const isCompound =
      state.resourcePattern !== undefined &&
      state.resourceQueue !== undefined &&
      state.currentResourceIndex !== undefined;
    if (isCompound) {
      return runCompoundPlan(state, azLookup);
    }
    return runLlmPlan(state, llmClient);
  };
}

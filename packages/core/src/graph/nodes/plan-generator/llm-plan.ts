/**
 * LLM-mode plan generation for plan-generator.
 *
 * Standalone (non-compound) path: prompt an LLM for a flat CFN properties
 * JSON object, parse + un-fence + un-wrap, strip placeholders / hallucinated
 * ARNs, merge elicited options, sanitize against schema, repair required
 * fields, resolve AMI / NAT-Gateway EIP specials, and emit logs.
 *
 * This file is now a **thin orchestrator** — all phase bodies live in the
 * sibling modules under `./llm-plan/`:
 *   - `./llm-plan/invoke.ts` — pre-flight + prompt + LLM call + JSON parse.
 *   - `./llm-plan/merge.ts` — placeholder strip + elicitedOptions merge.
 *   - `./llm-plan/sanitize.ts` — schema sanitisation + required-field repair.
 *   - `./llm-plan/resource-post-process.ts` — EC2 AMI / NAT EIP / EC2 SSH.
 *
 * SRP: one reason to change — the LLM path's orchestration order.
 *
 * Public surface: only `runLlmPlan` is exported. Sibling modules are internal.
 */
import type { LlmPort } from "@/index.js";
import { log, LOG_ACTIONS } from "@/utils/logger/index.js";
import type { AgentState } from "../../graph-state.js";
import { invokeLlmPhase } from "./llm-plan/invoke.js";
import { mergeElicitedOptions, stripPlaceholders } from "./llm-plan/merge.js";
import { repairRequired, sanitizeAgainstSchema } from "./llm-plan/sanitize.js";
import {
  postRepairPostProcess,
  preRepairPostProcess,
} from "./llm-plan/resource-post-process.js";

/** Entrypoint for the LLM path. Returns a partial AgentState. */
export async function runLlmPlan(
  state: AgentState,
  llmClient: LlmPort,
): Promise<Partial<AgentState>> {
  const invoke = await invokeLlmPhase(state, llmClient);
  if (invoke.kind === "short-circuit") return invoke.state;

  const { schemaKeys, requiredKeys, memoryHints, startedAt } = invoke;
  const resourceType = state.resourceType ?? "";
  let desiredState = invoke.desiredState;

  // Phase 2 — plugin placeholder strip + user-elicited merge.
  desiredState = stripPlaceholders(desiredState, resourceType);
  desiredState = mergeElicitedOptions(desiredState, state);

  // Phase 3a — schema sanitize (strip extraneous keys + coerce types).
  desiredState = sanitizeAgainstSchema(
    desiredState,
    state.resourceSchema ?? {},
    schemaKeys,
    state.runId,
  );

  // Phase 4a — pre-repair post-processing (EC2 AMI / NAT EIP).
  // MUST run BEFORE repair: repair fills ImageId with a plugin default
  // (OS-name shaped) that must NOT be resolved (pre-refactor behaviour).
  const preRepair = await preRepairPostProcess(desiredState, state);
  if (preRepair.kind === "short-circuit") return preRepair.state;
  desiredState = preRepair.desiredState;

  // Phase 3b — required-field repair (generic plugin-default injection).
  const repaired = repairRequired(desiredState, resourceType, requiredKeys);
  desiredState = repaired.desiredState;

  // Phase 4b — post-repair post-processing (EC2 SG cleanup + SSH injection).
  desiredState = postRepairPostProcess(desiredState, state);

  log({
    ts: new Date().toISOString(),
    runId: state.runId,
    level: "info",
    action: LOG_ACTIONS.PLAN_GENERATED,
    durationMs: Date.now() - startedAt,
    extras: {
      resourceType: state.resourceType,
      ...(repaired.injectedFields.length > 0
        ? {
            repairedFields: repaired.injectedFields.map(
              (f) => `${f.field}(${f.source})`,
            ),
          }
        : {}),
    },
  });

  return {
    desiredState,
    ...(memoryHints.length > 0 ? { memoryHints } : {}),
  };
}

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
import {
  mergeElicitedOptions,
  mergePluginDefaults,
  stripPlaceholders,
} from "./llm-plan/merge.js";
import {
  applyUserStatedVolumeSize,
  repairRequired,
  sanitizeAgainstSchema,
} from "./llm-plan/sanitize.js";
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
  // Order matters:
  //   a) `stripPlaceholders` removes plugin-registered placeholder
  //      sentinels the LLM parroted back ("example-value", "<YOUR-ID>").
  //   b) `mergeElicitedOptions` spreads user wizard answers on top of
  //      the LLM output (user assertions win over LLM guesses).
  desiredState = stripPlaceholders(desiredState, resourceType);
  desiredState = mergeElicitedOptions(desiredState, state);

  // Phase 3a — schema sanitize (strip extraneous keys + coerce types +
  // resource-aware CCAPI-shape rules from story e92.1.a). Passing
  // `resourceType` is what arms the DDB / ECS / CloudFront shape rules
  // — keep this argument live (story e92.1.a-followup).
  //
  // NOTE: `mergePluginDefaults` runs AFTER sanitize (Phase 3a.1 below).
  // Previously it ran here (pre-sanitize) which caused the sanitizer to
  // strip injected plugin defaults when the live CFN schema did not
  // include the key at the top level (e.g. `CreditSpecification` was
  // trimmed from older/cached schema snapshots). Moving the merge to
  // post-sanitize ensures injected keys are never subject to schema
  // stripping — the plugin registry only carries canonical CFN keys so
  // the risk of shipping a non-schema key is minimal and bounded by the
  // allowlist in `LLM_PATH_PLUGIN_DEFAULT_BACKFILL_ALLOWLIST`.
  // Fixes: e96.W2.R5 (t3.micro CreditSpecification) + e98.W2.R2 (C-R1).
  desiredState = sanitizeAgainstSchema(
    desiredState,
    state.resourceSchema ?? {},
    schemaKeys,
    state.runId,
    resourceType,
  );

  // Phase 3a.1 — plugin-defaults backfill (e96.W2.R5-part-2, e98.W2.R2).
  // Fills in plugin-level defaults for keys still missing / empty-leaf
  // after sanitize — e.g. the EC2 plugin's
  // `CreditSpecification: {CPUCredits: "standard"}` that was missing on
  // ~60% of LLM runs. Runs AFTER sanitize so the injected keys cannot be
  // stripped by the schema sanitizer (root cause of the probes). Compound-
  // plan already does the analogous spread at its top
  // (see `compound-plan.ts:66-68`); this closes the parity gap.
  //
  // Re: BP-enforcement safety — S3 and DynamoDB are NOT on the backfill
  // allowlist (see `LLM_PATH_PLUGIN_DEFAULT_BACKFILL_ALLOWLIST`), so
  // moving this step post-sanitize does NOT auto-fix S3/DDB plans
  // and BP-S3-001/BP-DYN rules still fire as expected.
  desiredState = mergePluginDefaults(desiredState, resourceType);

  // Phase 3a.5 — user-stated VolumeSize fidelity (e98.W2.R4).
  // Runs AFTER sanitize (so schema coercion doesn't clobber the override)
  // and BEFORE repair (so the user value survives required-field logic).
  // Deterministic regex patcher — scoped to EC2::Instance; no-op for
  // every other resource type. Closes Epic 97 C-R2: user says `100GB`,
  // gets `100GB` on the plan row, not the LLM's 8GB default.
  desiredState = applyUserStatedVolumeSize(
    desiredState,
    resourceType,
    state.userIntent ?? "",
    state.runId,
  );

  // Phase 4a — pre-repair post-processing (EC2 AMI / NAT EIP).
  // MUST run BEFORE repair: repair fills ImageId with a plugin default
  // (OS-name shaped) that must NOT be resolved (pre-refactor behaviour).
  const preRepair = await preRepairPostProcess(desiredState, state);
  if (preRepair.kind === "short-circuit") return preRepair.state;
  desiredState = preRepair.desiredState;

  // Phase 3b — required-field repair (generic plugin-default injection
  // SPECIFIC to schema-required keys). Complementary to the broader
  // plugin-defaults backfill in Phase 2: Phase 3b ensures the CFN
  // schema's required keys are always populated (loud-fail sentinel if
  // the plugin doesn't have a default), Phase 2 fills optional keys
  // the plugin declared for UX polish.
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

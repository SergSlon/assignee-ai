/**
 * LLM-plan phase 1: invocation.
 *
 * Pre-flight → memory hints → prompt → LLM call (callsite `plan_generator`
 * per `feedback_token_cost_visibility.md`; Bedrock region/error hints
 * preserved via `genErr.message` surfacing per `feedback_bedrock_region_error_hints.md`)
 * → JSON parse → CFN-wrapper unwrap. Returns `InvokeSuccess` on the happy
 * path or a `short-circuit` `Partial<AgentState>` (FAILED + hint) otherwise.
 */
import {
  ExecutionStatus,
  defaultPluginRegistry,
  CfnKey,
  type LlmPort,
} from "@/index.js";
import { EnvVar } from "@/constants/env-vars.js";
import { log, LOG_ACTIONS } from "@/utils/logger/index.js";
import { ProcessEnvConfigAdapter } from "@/config/config-port.js";
import type { AgentState } from "@/graph/graph-state.js";
import {
  readMemoryHints,
  buildPrompt,
  parseLlmJsonResponse,
  unwrapCfnResourcesWrapper,
} from "../llm-helpers.js";

export type InvokeResult =
  | {
      kind: "ok";
      desiredState: Record<string, unknown>;
      schemaKeys: string[];
      requiredKeys: string[];
      memoryHints: string[];
      startedAt: number;
    }
  | { kind: "short-circuit"; state: Partial<AgentState> };

/** Extracts schema metadata from the CFN schema (SDK-cased + MCP-cased). */
function readSchemaMetadata(resourceSchema: Record<string, unknown>): {
  schemaKeys: string[];
  requiredKeys: string[];
} {
  const schemaProperties =
    (resourceSchema[CfnKey.CFN_PROPERTIES] as
      | Record<string, unknown>
      | undefined) ??
    (resourceSchema["Properties"] as Record<string, unknown> | undefined) ??
    {};
  return {
    schemaKeys: Object.keys(schemaProperties),
    requiredKeys:
      (resourceSchema[CfnKey.CFN_REQUIRED] as string[] | undefined) ?? [],
  };
}

/**
 * Emits a POC guardrail warning when `BEDROCK_GUARDRAIL_ID` is unset.
 *
 * MASTER-009: reads via a fresh ConfigPort adapter rather than reaching
 * at process.env directly. TODO(SaaS): thread ConfigPort from graph
 * state once W4 lands.
 */
function warnIfGuardrailDisabled(runId: string): void {
  if (new ProcessEnvConfigAdapter().get(EnvVar.BEDROCK_GUARDRAIL_ID)) return;
  log({
    ts: new Date().toISOString(),
    runId,
    level: "warn",
    action: LOG_ACTIONS.GUARDRAIL_DISABLED,
    extras: {
      message: "BEDROCK_GUARDRAIL_ID not set — guardrail disabled for POC",
    },
  });
}

/** Phase 1 entrypoint: pre-flight + LLM call + parse. */
export async function invokeLlmPhase(
  state: AgentState,
  llmClient: LlmPort,
): Promise<InvokeResult> {
  if (state.executionStatus !== ExecutionStatus.PENDING) {
    return { kind: "short-circuit", state: {} };
  }
  if (!state.resourceSchema) {
    return {
      kind: "short-circuit",
      state: {
        executionStatus: ExecutionStatus.FAILED,
        errorMessage:
          "Cannot generate plan: resource schema is missing. Hint: check CloudFormation Registry SDK connectivity and ASSIGNEE_OPERATOR credentials.",
      },
    };
  }

  const startedAt = Date.now();
  const { schemaKeys, requiredKeys } = readSchemaMetadata(state.resourceSchema);
  warnIfGuardrailDisabled(state.runId);

  const { provisionHintLine, memoryHints } = await readMemoryHints(state);
  const resourceHints =
    defaultPluginRegistry.get(state.resourceType ?? "")?.configHints ?? [];

  const prompt = buildPrompt({
    resourceType: state.resourceType ?? "",
    userIntent: state.userIntent ?? "",
    schemaKeys,
    requiredKeys,
    resourceSchema: state.resourceSchema,
    resourceHints,
    provisionHintLine,
  });

  const [genErr, text] = await llmClient.generateText(prompt, {
    callsite: "plan_generator",
    runId: state.runId,
  });

  if (genErr || !text) {
    return {
      kind: "short-circuit",
      state: {
        executionStatus: ExecutionStatus.FAILED,
        errorMessage: `Plan generation failed. Hint: check Bedrock connectivity and AWS credentials.${genErr ? ` Error: ${genErr.message}` : ""}`,
      },
    };
  }

  let desiredState: Record<string, unknown>;
  try {
    desiredState = parseLlmJsonResponse(text);
  } catch (err) {
    log({
      ts: new Date().toISOString(),
      runId: state.runId,
      level: "warn",
      action: LOG_ACTIONS.PLAN_GENERATED,
      extras: { result: "invalid_json", error: String(err) },
    });
    return {
      kind: "short-circuit",
      state: {
        executionStatus: ExecutionStatus.FAILED,
        errorMessage:
          "Plan generator returned invalid JSON. Hint: try rephrasing your intent.",
      },
    };
  }

  return {
    kind: "ok",
    desiredState: unwrapCfnResourcesWrapper(desiredState),
    schemaKeys,
    requiredKeys,
    memoryHints,
    startedAt,
  };
}

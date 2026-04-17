/**
 * LLM-mode plan generation for plan-generator.
 *
 * Standalone (non-compound) path: prompt an LLM for a flat CFN properties
 * JSON object, parse + un-fence + un-wrap, strip placeholders / hallucinated
 * ARNs, merge elicited options, sanitize against schema, repair required
 * fields, resolve AMI / NAT-Gateway EIP specials, and emit logs.
 *
 * SRP: one reason to change — the LLM path's orchestration order.
 * Pure helpers (prompt building, response parsing, memory lookup, CFN
 * unwrap) live in `./llm-helpers.ts`.
 */
import {
  ExecutionStatus,
  defaultPluginRegistry,
  RESOURCE_TYPES,
  CfnKey,
  EIP_AUTO_ALLOCATE,
  ResourceDefault,
  AwsDefault,
  type LlmPort,
} from "@assignee/core";
import { EnvVar } from "../../../constants/env-vars.js";
import { log, LOG_ACTIONS } from "../../../utils/logger/index.js";
import { resolveAmiFromOsName } from "../../../utils/aws-resource-discovery/index.js";
import { sanitizeDesiredState } from "../../../services/desired-state-sanitizer.js";
import { repairRequiredFields } from "../../../services/required-field-repairer.js";
import type { AgentState } from "../../graph-state.js";
import { applyToCfnTransforms } from "./cfn-emitter.js";
import {
  collectPluginPlaceholders,
  stripEmpty,
  stripPlaceholderArns,
} from "./placeholders.js";
import {
  readMemoryHints,
  buildPrompt,
  parseLlmJsonResponse,
  unwrapCfnResourcesWrapper,
} from "./llm-helpers.js";

/** Entrypoint for the LLM path. Returns a partial AgentState. */
export async function runLlmPlan(
  state: AgentState,
  llmClient: LlmPort,
): Promise<Partial<AgentState>> {
  if (state.executionStatus !== ExecutionStatus.PENDING) return {};
  if (!state.resourceSchema) {
    return {
      executionStatus: ExecutionStatus.FAILED,
      errorMessage:
        "Cannot generate plan: resource schema is missing. Hint: check CloudFormation Registry SDK connectivity and ASSIGNEE_OPERATOR credentials.",
    };
  }

  const startedAt = Date.now();
  // CloudFormation Registry SDK returns lowercase "properties"; older MCP
  // servers used "Properties".
  const schemaProperties =
    (state.resourceSchema[CfnKey.CFN_PROPERTIES] as
      | Record<string, unknown>
      | undefined) ??
    (state.resourceSchema["Properties"] as
      | Record<string, unknown>
      | undefined) ??
    {};
  const schemaKeys = Object.keys(schemaProperties);
  const requiredKeys: string[] =
    (state.resourceSchema[CfnKey.CFN_REQUIRED] as string[] | undefined) ?? [];

  if (!process.env[EnvVar.BEDROCK_GUARDRAIL_ID]) {
    log({
      ts: new Date().toISOString(),
      runId: state.runId,
      level: "warn",
      action: LOG_ACTIONS.GUARDRAIL_DISABLED,
      extras: {
        message: "BEDROCK_GUARDRAIL_ID not set — guardrail disabled for POC",
      },
    });
  }

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
      executionStatus: ExecutionStatus.FAILED,
      errorMessage: `Plan generation failed. Hint: check Bedrock connectivity and AWS credentials.${genErr ? ` Error: ${genErr.message}` : ""}`,
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
      executionStatus: ExecutionStatus.FAILED,
      errorMessage:
        "Plan generator returned invalid JSON. Hint: try rephrasing your intent.",
    };
  }

  desiredState = unwrapCfnResourcesWrapper(desiredState);

  const pluginPlaceholders = collectPluginPlaceholders(
    state.resourceType ?? "",
  );
  desiredState = stripEmpty(desiredState, pluginPlaceholders);
  stripPlaceholderArns(desiredState);

  // Merge elicited options — user-confirmed values override LLM-generated
  // values. Apply toCfn transforms to convert boolean answers to valid
  // CFN structures.
  if (state.elicitedOptions && Object.keys(state.elicitedOptions).length > 0) {
    const transformed = applyToCfnTransforms(
      state.elicitedOptions,
      state.resourceType ?? "",
    );
    desiredState = { ...desiredState, ...transformed };

    // Delete LLM-generated values that the user explicitly declined
    // (toCfn returned undefined).
    const plugin = defaultPluginRegistry.get(state.resourceType ?? "");
    if (plugin) {
      const allFields = [...plugin.commonFields, ...plugin.advancedFields];
      for (const [key, value] of Object.entries(state.elicitedOptions)) {
        const field =
          allFields.find((f) => {
            if (f.name !== key) return false;
            if (!f.question.showIf) return true;
            const { field: depField, value: depValue } = f.question.showIf;
            return state.elicitedOptions?.[depField] === depValue;
          }) ?? allFields.find((f) => f.name === key);
        if (field?.toCfn && field.toCfn(value) === undefined) {
          delete desiredState[key];
        }
      }
    }
  }

  // Sanitize against schema — strip extraneous keys (recursive) + coerce
  // types. MUST run AFTER elicitedOptions merge since plugins may add
  // non-schema keys (e.g., DynamoDB PointInTimeRecoveryEnabled is a plugin
  // field, not a CFN property).
  if (schemaKeys.length > 0) {
    const { sanitized, strippedKeys, coercedKeys } = sanitizeDesiredState(
      desiredState,
      state.resourceSchema,
    );
    desiredState = sanitized;
    if (strippedKeys.length > 0 || coercedKeys.length > 0) {
      log({
        ts: new Date().toISOString(),
        runId: state.runId,
        level: "info",
        action: LOG_ACTIONS.PLAN_GENERATED,
        extras: {
          sanitized: true,
          strippedKeys,
          coercedKeys: coercedKeys.map((c) => `${c.path}: ${c.from}→${c.to}`),
        },
      });
    }
  }

  // Resolve OS name to real AMI ID for EC2 instances.
  if (
    state.resourceType === RESOURCE_TYPES.EC2_INSTANCE &&
    typeof desiredState[CfnKey.IMAGE_ID] === "string" &&
    !String(desiredState[CfnKey.IMAGE_ID]).startsWith("ami-")
  ) {
    const osName = String(desiredState[CfnKey.IMAGE_ID]);
    const resolvedAmi = await resolveAmiFromOsName(osName);
    if (resolvedAmi) {
      desiredState[CfnKey.IMAGE_ID] = resolvedAmi;
    } else {
      return {
        desiredState: {},
        executionStatus: ExecutionStatus.FAILED,
        errorMessage: `Cannot resolve "${osName}" to a real AMI ID. Please either:\n  1. Run "aws sso login" to refresh credentials, then retry\n  2. Use "Other" in the AMI field and enter a real AMI ID (e.g., ami-0c55b159cbfafe1f0)`,
      };
    }
  }

  // Story E2E.5: NatGateway with public connectivity requires an EIP
  // AllocationId. Insert a placeholder that resource_provisioner resolves
  // at apply time. We must NOT allocate a real EIP during plan generation —
  // if the user runs `plan` but never `apply`, the EIP would leak ($3.60/mo).
  if (
    state.resourceType === RESOURCE_TYPES.EC2_NAT_GATEWAY &&
    (desiredState[CfnKey.CONNECTIVITY_TYPE] ===
      AwsDefault.CONNECTIVITY_PUBLIC ||
      !desiredState[CfnKey.CONNECTIVITY_TYPE]) &&
    (!desiredState[CfnKey.ALLOCATION_ID] ||
      desiredState[CfnKey.ALLOCATION_ID] === EIP_AUTO_ALLOCATE)
  ) {
    desiredState[CfnKey.ALLOCATION_ID] = EIP_AUTO_ALLOCATE;
  }

  // Story E2E.3: Generic required-field repairer — fills missing required
  // fields from plugin defaults. Replaces one-off Lambda Code special case.
  const { repaired: repairedState, injectedFields } = repairRequiredFields(
    desiredState,
    state.resourceType ?? "",
    requiredKeys,
  );
  desiredState = repairedState;

  // EC2 post-processing: clean up LLM artifacts and handle SSH intent.
  if (state.resourceType === RESOURCE_TYPES.EC2_INSTANCE) {
    const sgIds = desiredState[CfnKey.SECURITY_GROUP_IDS];
    if (Array.isArray(sgIds)) {
      const valid = (sgIds as string[]).filter(
        (id) => typeof id === "string" && id.startsWith("sg-"),
      );
      if (valid.length === 0) {
        delete desiredState[CfnKey.SECURITY_GROUP_IDS];
      } else {
        desiredState[CfnKey.SECURITY_GROUP_IDS] = valid;
      }
    }
    // SSH intent: inject key pair placeholder if user wants SSH but LLM
    // omitted KeyName.
    if (state.userIntent && /\bssh\b/i.test(state.userIntent)) {
      if (!desiredState[CfnKey.KEY_NAME]) {
        desiredState[CfnKey.KEY_NAME] = ResourceDefault.SSH_KEY_PLACEHOLDER;
      }
    }
  }

  log({
    ts: new Date().toISOString(),
    runId: state.runId,
    level: "info",
    action: LOG_ACTIONS.PLAN_GENERATED,
    durationMs: Date.now() - startedAt,
    extras: {
      resourceType: state.resourceType,
      ...(injectedFields.length > 0
        ? {
            repairedFields: injectedFields.map(
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

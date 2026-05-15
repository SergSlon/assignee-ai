// ---------------------------------------------------------------------------
// intent-parser/index.ts — orchestrator for the decomposed intent parser.
// ---------------------------------------------------------------------------
//
// RW7 lead-merge artefact. The 1531-LOC monolith at
// `packages/core/src/graph/nodes/intent-parser.ts` was split into focused
// extractor / validator / type clusters under this directory. This file is
// the orchestrator that:
//
//   1. composes `extractAssertedValues` from the cluster extractors,
//   2. exposes the `createIntentParserNode` LangGraph factory,
//   3. re-exports the public API surface (validators + types +
//      `resolveNameField`) so external callers continue to work via the
//      `intent-parser.ts` re-export shim.
//
// LOC budget: ≤ 150 (the manifest's cluster summary). Helpers that the
// monolith kept private (mergeElicited / mergePresetFields / mergeAdvisories /
// buildExtractionFailureUpdate / patternPrimaryResourceType) live in this
// file — a follow-up micro-wave can split them into a sibling
// `orchestrator-helpers.ts` once the dedupe wave touches the cluster files.

import { z } from "zod";
import {
  ExecutionStatus,
  PatternId,
  RESOURCE_TYPES,
  SUPPORTED_TYPES_ARRAY as SUPPORTED_TYPES,
  defaultPatternRegistry,
  renderSupportedTypesHint,
  sanitizeUserIntent,
} from "../../../index.js";
import { AssigneeError } from "../../../errors.js";
import type { LlmPort } from "../../../index.js";
import { classifyCompoundViaLlm } from "./compound-classifier-llm.js";
import {
  resolveCompoundPatternIdLiteral,
  resolveSingletonOverride,
} from "../../../intent/compound-keywords.js";
import { log, LOG_ACTIONS } from "../../../utils/logger/index.js";
import type { AgentState } from "../../graph-state.js";
import type { Advisory, AssertionExtraction } from "./intent-types.js";
import {
  extractCidr,
  extractRegion,
  extractSgIngress,
  extractNoVpcDirective,
} from "./extractors/network-extractors.js";
import {
  extractInstanceType,
  extractAmiId,
  extractEngineVersion,
  extractDbInstanceClass,
} from "./extractors/compute-extractors.js";
import {
  extractResourceName,
  extractInlineName,
} from "./extractors/name-extractor.js";
import {
  extractSnsProtocol,
  extractEmailForSnsCompound,
} from "./extractors/messaging-extractors.js";
import {
  extractCloudWatchAlarmMetric,
  extractRetentionDays,
} from "./extractors/cloudwatch-extractor.js";
import { extractS3Lifecycle } from "./extractors/s3-lifecycle-extractor.js";
import { extractLambdaBody } from "./extractors/lambda-body-extractor.js";
import { applyRdsTierDefaults } from "./extractors/environment-tier-extractor.js";
import { extractVpcDefaultHint } from "./extractors/vpc-default-hint-extractor.js";
import { extractExisting } from "./extractors/existing-resource-extractor.js";
import { productionResourceDiscoveryPort } from "../../../services/resource-discovery-port.js";
import { AWS_REGION } from "../../../config/constants/aws.js";

// Public re-exports — preserve the monolith's external API surface.
export type { Advisory, AssertionExtraction } from "./intent-types.js";
export { resolveNameField } from "./extractors/name-extractor.js";
export {
  isValidCidr,
  isValidInstanceType,
  isValidAmiId,
  isValidEngineVersion,
} from "./validators/token-validators.js";

const SUPPORTED_TYPES_HINT = renderSupportedTypesHint("short");

/**
 * MED 1: Type guard for AgentState["intentKind"] — replaces unsafe `as` casts.
 * The Zod schema constrains output.kind to the enum, but TypeScript still
 * requires a type guard to narrow `string` to the union without `as`.
 */
function isIntentKind(v: unknown): v is AgentState["intentKind"] {
  return v === "create" || v === "query" || v === "destroy" || v === "update";
}

/**
 * Extended intent classification schema — adds a `kind` discriminant so the
 * graph can route read-only queries away from the heavy creation pipeline.
 *
 * Back-compat guarantee: `kind` defaults to `"create"` on parse failure or
 * when the LLM omits it, so every existing creation-intent test passes
 * unchanged. `resourceType` is still required; for `kind=query` the LLM
 * returns the inferred type (e.g. "AWS::CloudFront::Distribution") OR
 * "UNSUPPORTED" when no specific type was identified.
 */
const intentParserSchema = z.object({
  resourceType: z.enum([...SUPPORTED_TYPES, "UNSUPPORTED"] as [
    string,
    ...string[],
  ]),
  kind: z.enum(["create", "query", "destroy", "update"]).default("create"),
});

/**
 * Pre-extract user-asserted values from the natural-language intent. The
 * extractor is intentionally conservative: a token is recognised only when
 * unambiguous (CIDR shape, AMI shape, known instance family + suffix,
 * known region). Tokens that LOOK like an assertion but fail validation
 * produce a user-visible error — never a silent fallback to defaults.
 *
 * Order matters: CIDR runs before SgIngress so the primary CIDR is bound
 * before ingress assembly; the rest are independent and safe to reorder.
 */
export function extractAssertedValues(
  intent: string,
  resourceType: string,
): AssertionExtraction {
  const elicited: Record<string, unknown> = {};
  const errors: string[] = [];
  const advisories: Advisory[] = [];
  const intentLower = intent.toLowerCase();
  const errorCodeBox: { code?: string } = {};

  extractCidr(intent, resourceType, elicited, errors);
  extractInstanceType(intent, elicited, errors);
  extractAmiId(intent, elicited, errors);
  extractRegion(intent, elicited, errors);
  extractEngineVersion(intent, intentLower, elicited, errors);
  extractDbInstanceClass(intent, intentLower, elicited, errors);
  extractResourceName(
    intent,
    resourceType,
    elicited,
    errors,
    advisories,
    errorCodeBox,
  );
  // SX-2 / PH1-C-1 — inline-name fallback (after the keyword path so
  // explicit "named X" / "called X" still wins).
  extractInlineName(intent, resourceType, elicited, advisories);
  extractSgIngress(intent, elicited, errors);
  extractNoVpcDirective(intentLower, elicited);
  extractSnsProtocol(intent, intentLower, resourceType, elicited);
  // CP-2: extract email for sns-with-email-subscription compound (primary type
  // is SNS_TOPIC; Endpoint is scoped to SNS_SUBSCRIPTION via filterElicitedForSlot).
  extractEmailForSnsCompound(
    intent,
    intentLower,
    resourceType,
    elicited,
    advisories,
  );
  extractRetentionDays(intent, intentLower, resourceType, elicited);
  extractCloudWatchAlarmMetric(intentLower, resourceType, elicited);
  extractS3Lifecycle(intent, intentLower, resourceType, elicited, advisories);
  extractLambdaBody(intent, resourceType, elicited);
  applyRdsTierDefaults(intent, resourceType, elicited, advisories);
  // CP-3: detect "vpc-default" / "default VPC" / "existing VPC <id>" — result
  // stored in _VpcDefaultHint for the efs-default-vpc-hint advisor to consume.
  const vpcDefaultHint = extractVpcDefaultHint(intent);
  if (vpcDefaultHint !== null) {
    elicited["_VpcDefaultHint"] = vpcDefaultHint;
  }

  return {
    elicited,
    errors,
    advisories,
    ...(errorCodeBox.code !== undefined
      ? { errorCode: errorCodeBox.code }
      : {}),
  };
}

/** Pattern → primary name-bearing resource type (closes A-02). */
function patternPrimaryResourceType(patternId: string): string | null {
  switch (patternId) {
    case PatternId.LAMBDA_WITH_EXEC_ROLE:
    case PatternId.SERVERLESS_API:
    case PatternId.SCHEDULED_LAMBDA:
    case PatternId.WEBSOCKET_API:
      return RESOURCE_TYPES.LAMBDA_FUNCTION;
    case PatternId.CONTAINER_SERVICE:
      return RESOURCE_TYPES.ECS_CLUSTER;
    case PatternId.MESSAGE_PROCESSING:
      return RESOURCE_TYPES.SQS_QUEUE;
    case PatternId.STATIC_WEBSITE:
      return RESOURCE_TYPES.S3_BUCKET;
    case PatternId.SNS_WITH_EMAIL_SUBSCRIPTION:
      return RESOURCE_TYPES.SNS_TOPIC;
    default:
      return null;
  }
}

/** Merge parser-asserted values with pre-existing elicitedOptions (additive). */
function mergeElicited(
  existing: Record<string, unknown> | undefined,
  asserted: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const assertedKeys = Object.keys(asserted);
  if (assertedKeys.length === 0) return existing;
  const base = existing ?? {};
  const merged: Record<string, unknown> = { ...base };
  for (const key of assertedKeys) {
    if (!(key in merged)) merged[key] = asserted[key];
  }
  return merged;
}

/** Mirror scalar asserted values into presetFields (NEVER_ASK propagation). */
function mergePresetFields(
  existing: Record<string, string> | undefined,
  asserted: Record<string, unknown>,
): Record<string, string> | undefined {
  const base: Record<string, string> = { ...(existing ?? {}) };
  let changed = false;
  for (const [key, value] of Object.entries(asserted)) {
    if (key.startsWith("__")) continue;
    if (key in base) continue;
    if (
      typeof value === "string" ||
      typeof value === "boolean" ||
      typeof value === "number"
    ) {
      base[key] = String(value);
      changed = true;
    }
  }
  if (!changed && existing === undefined) return undefined;
  return base;
}

/** Concatenate newly-emitted advisories with any already on state. */
function mergeAdvisories(
  existing: Advisory[] | undefined,
  added: Advisory[],
): Advisory[] | undefined {
  if (added.length === 0) return existing;
  return [...(existing ?? []), ...added];
}

/** Build the FAILED partial-state object for an extraction with errors. */
function buildExtractionFailureUpdate(
  safeIntent: string,
  extraction: AssertionExtraction,
): Partial<AgentState> {
  const errorMessage = `Intent validation failed: ${extraction.errors.join(" ")}`;
  return {
    userIntent: safeIntent,
    executionStatus: ExecutionStatus.FAILED,
    errorMessage,
    ...(extraction.errorCode !== undefined
      ? { error: new AssigneeError(errorMessage, extraction.errorCode) }
      : {}),
  };
}

/**
 * Assemble the orchestrator's success-branch partial state once an
 * extraction has resolved cleanly. Centralised so the four entry paths
 * (singleton-override / literal pattern / registry detect / LLM
 * classify) emit byte-for-byte identical merge results.
 */
function buildExtractionSuccessUpdate(
  safeIntent: string,
  extraction: AssertionExtraction,
  state: AgentState,
  resolution:
    | { resourceType: string }
    | { resourcePattern: NonNullable<AgentState["resourcePattern"]> },
  existingResources?: AgentState["existingResources"],
  discoveryAdvisory?: Advisory,
): Partial<AgentState> {
  const merged = mergeElicited(state.elicitedOptions, extraction.elicited);
  const mergedPresets = mergePresetFields(
    state.presetFields,
    extraction.elicited,
  );
  // EPIC-107-2 R1: append discoveryAdvisory (when set) into the same
  // advisory stream the extraction emits — order preserved (extraction
  // first, discovery last).
  const advisoriesIn = discoveryAdvisory
    ? [...extraction.advisories, discoveryAdvisory]
    : extraction.advisories;
  const mergedAdvisories = mergeAdvisories(state.advisories, advisoriesIn);
  return {
    userIntent: safeIntent,
    ...resolution,
    ...(merged !== undefined ? { elicitedOptions: merged } : {}),
    ...(mergedPresets !== undefined ? { presetFields: mergedPresets } : {}),
    ...(mergedAdvisories !== undefined ? { advisories: mergedAdvisories } : {}),
    ...(existingResources !== undefined && existingResources.length > 0
      ? { existingResources }
      : {}),
  };
}

/**
 * Factory for the intent_parser LangGraph node. Mirrors the monolith
 * dispatch order: singleton-override → literal pattern → registry detect
 * → LLM classify. Every branch routes through `extractAssertedValues`
 * and the same merge helpers.
 */
export function createIntentParserNode({ llmClient }: { llmClient: LlmPort }) {
  return async function intentParserNode(
    state: AgentState,
  ): Promise<Partial<AgentState>> {
    const safeIntent = sanitizeUserIntent(state.userIntent);

    // EPIC-107-2 (PH1-G-2): discover existing AWS resources matching the
    // user's intent. Runs before classification so compound-pattern
    // consumers can reference Existing nodes. Failure is swallowed by the
    // port impl — no crash, CP-3 advisory path still renders.
    const region =
      state.config?.get("AWS_REGION") ??
      state.config?.get("AWS_DEFAULT_REGION") ??
      AWS_REGION;
    const discoveryPort = productionResourceDiscoveryPort(region, state.runId);
    const {
      existing: existingResources,
      ambiguous,
      needsElicitation,
    } = await extractExisting(safeIntent, discoveryPort, region);

    // EPIC-107-2 R2 (review finding #4, supersedes R1 #3): when one or more
    // resource kinds had multiple candidates that could not be auto-
    // disambiguated, the extractor drops them from `existing[]` (no graph-
    // state pollution) and reports them in `ambiguous[]`. We emit an
    // advisory that names the ambiguous kinds + candidate counts so the
    // user can rephrase. The option-elicitor picker is deferred (per ADR
    // Decision 2 fallback): advisory now, picker later.
    const discoveryAdvisory: Advisory | undefined = needsElicitation
      ? {
          code: "EXISTING_RESOURCE_AMBIGUOUS",
          message:
            `Multiple existing resources matched your intent — ` +
            ambiguous
              .map((a) => `${a.candidates.length} ${a.kind}s`)
              .join(", ") +
            `. Plan continues without selecting any of them.`,
          hint: "Rephrase your intent to include a distinguishing name fragment (e.g., 'staging VPC', 'prod cluster') so discovery can auto-select.",
          details: {
            ambiguousKinds: ambiguous.map((a) => ({
              kind: a.kind,
              count: a.candidates.length,
              candidateIds: a.candidates.map((c) => c.id),
            })),
          },
        }
      : undefined;

    // Step 1 — Singleton-override cues (C-08, C-09).
    const singletonType = resolveSingletonOverride(safeIntent);
    if (
      singletonType !== null &&
      (SUPPORTED_TYPES as readonly string[]).includes(singletonType)
    ) {
      const extraction = extractAssertedValues(safeIntent, singletonType);
      if (extraction.errors.length > 0) {
        return buildExtractionFailureUpdate(safeIntent, extraction);
      }
      log({
        ts: new Date().toISOString(),
        runId: state.runId,
        level: "info",
        action: LOG_ACTIONS.INTENT_PARSED,
        extras: { resourceType: singletonType, pattern: null },
      });
      return {
        ...buildExtractionSuccessUpdate(
          safeIntent,
          extraction,
          state,
          {
            resourceType: singletonType,
          },
          existingResources,
          discoveryAdvisory,
        ),
        intentKind: "create" as const,
      };
    }

    // Step 2 — Pattern-ID literal lookup (C-07) → falls through to detect.
    const literalPatternId = resolveCompoundPatternIdLiteral(safeIntent);
    const literalPattern =
      literalPatternId !== null
        ? defaultPatternRegistry.get(literalPatternId)
        : undefined;

    // Step 3 — Normal pattern detection (registry-level substring match).
    const detectedPattern =
      literalPattern ?? defaultPatternRegistry.detect(safeIntent);
    if (detectedPattern !== undefined && detectedPattern !== null) {
      const primaryType =
        patternPrimaryResourceType(detectedPattern.patternId) ?? "";
      const extraction = extractAssertedValues(safeIntent, primaryType);
      if (extraction.errors.length > 0) {
        return buildExtractionFailureUpdate(safeIntent, extraction);
      }
      log({
        ts: new Date().toISOString(),
        runId: state.runId,
        level: "info",
        action: LOG_ACTIONS.INTENT_PARSED,
        extras: { resourceType: null, pattern: detectedPattern.patternId },
      });
      return {
        ...buildExtractionSuccessUpdate(
          safeIntent,
          extraction,
          state,
          {
            resourcePattern: detectedPattern,
          },
          existingResources,
          discoveryAdvisory,
        ),
        intentKind: "create" as const,
      };
    }

    // Step 3.5 — LLM compound-pattern fallback (Epic-107 Story 1).
    //
    // When both the literal-pattern lookup (Step 2) and the keyword-registry
    // detect (Step 3) return null, ask the LLM: "given the known compound
    // catalogue, which pattern (or NONE) fits this intent?"
    //
    // Gates:
    //   (a) Intent must be ≥ 10 words — short intents stay deterministic.
    //   (b) Only high/medium-confidence LLM answers are actioned.
    //   (c) Schema-rejection, low-confidence, and LLM errors all fall through
    //       to Step 4 (Bedrock resource-type classifier) unchanged.
    //
    // Cost: callsite "intent-parser/compound-classifier-llm" is logged so
    // per-call token spend is attributable in the structured-log stream
    // (feedback_token_cost_visibility).
    const llmCompoundResult = await classifyCompoundViaLlm(
      safeIntent,
      defaultPatternRegistry,
      llmClient,
      state.runId,
    );
    if (llmCompoundResult.kind === "match") {
      const llmPattern = defaultPatternRegistry.get(
        llmCompoundResult.patternKey,
      );
      if (llmPattern !== undefined) {
        const primaryType =
          patternPrimaryResourceType(llmPattern.patternId) ?? "";
        const extraction = extractAssertedValues(safeIntent, primaryType);
        if (extraction.errors.length > 0) {
          return buildExtractionFailureUpdate(safeIntent, extraction);
        }
        log({
          ts: new Date().toISOString(),
          runId: state.runId,
          level: "info",
          action: LOG_ACTIONS.INTENT_PARSED,
          extras: {
            resourceType: null,
            pattern: llmPattern.patternId,
            via: "llm-compound-fallback",
          },
        });
        return {
          ...buildExtractionSuccessUpdate(
            safeIntent,
            extraction,
            state,
            {
              resourcePattern: llmPattern,
            },
            existingResources,
            discoveryAdvisory,
          ),
          intentKind: "create" as const,
        };
      }
    }
    // kind === "no-match" or "skipped" — fall through to Step 4.

    // Step 4 — Bedrock classification on the sanitised intent.
    //
    // The prompt now requests TWO classifications:
    //   1. `kind`: whether this is a create / query / destroy / update intent.
    //   2. `resourceType`: the CFN type (same as before), OR "UNSUPPORTED".
    //
    // Back-compat: existing creation intents produce the same output as
    // before because `kind` defaults to "create" on parse failure.
    const prompt = `Classify this AWS infrastructure request.

Return JSON with two fields:
1. "kind": one of "create", "query", "destroy", "update".
   - "create": the user wants to provision a NEW resource.
   - "query": the user wants to READ, LIST, DESCRIBE, FIND, or ASK ABOUT existing resources. Examples: "what's my CloudFront URL?", "list my S3 buckets", "show me my Lambda functions", "how many EC2 instances do I have?", "what does my account cost?".
   - "destroy": the user wants to DELETE or REMOVE a resource.
   - "update": the user wants to MODIFY an existing resource.
   When in doubt, default to "create" for back-compat.

2. "resourceType": classify into one of these types: ${SUPPORTED_TYPES.join(", ")} or UNSUPPORTED.
   - For "query" kind: use the type the user is asking about if identifiable, otherwise "UNSUPPORTED".
   - For "create" kind: same rules as before.
   - If the request says "standalone", "bare", "single", "on its own", or "just the X", classify as that exact type.
   - Events::Connection and Events::ApiDestination ARE first-class types.
   - RDS::DBInstance MUST be classified when the request asks for a standalone database.

Request: "${safeIntent}"`;
    const [err, output] = await llmClient.generateStructured(
      prompt,
      intentParserSchema,
      { callsite: "intent_parser", runId: state.runId },
    );
    if (err) {
      // HIGH 5: Distinguish Zod schema-validation failures from network errors.
      // When the LLM halluccinates a resourceType not in the supported set (e.g.
      // "AWS::Foo::Bar"), the AI SDK's Output.object() throws a Zod validation
      // error. That is NOT a Bedrock connectivity issue — surfacing a
      // "check Bedrock connectivity" hint when Bedrock is fine is misleading.
      const isValidationFailure =
        err.message.includes("Validation") ||
        err.message.includes("validation") ||
        err.message.includes("Expected") ||
        err.message.includes("Invalid enum value") ||
        err.message.includes("ZodError");
      if (isValidationFailure) {
        log({
          ts: new Date().toISOString(),
          runId: state.runId,
          level: "warn",
          action: LOG_ACTIONS.INTENT_PARSED,
          extras: { outcome: "unsupported_resource", reason: "zod_validation" },
        });
        return {
          userIntent: safeIntent,
          executionStatus: ExecutionStatus.UNSUPPORTED_RESOURCE,
          errorMessage:
            "I couldn't tell whether you wanted to create, list, or describe something, " +
            "or the resource type you mentioned isn't supported yet. " +
            `Try \`assignee plan --help\` for examples of supported types. ${SUPPORTED_TYPES_HINT}.`,
        };
      }
      log({
        ts: new Date().toISOString(),
        runId: state.runId,
        level: "error",
        action: LOG_ACTIONS.INTENT_PARSED,
        extras: { outcome: "failed", reason: "llm_error" },
      });
      return {
        userIntent: safeIntent,
        executionStatus: ExecutionStatus.FAILED,
        errorMessage: `Intent parsing failed. Hint: check Bedrock connectivity and AWS credentials. Error: ${err.message}`,
      };
    }

    // ── Query-intent short-circuit ────────────────────────────────────────
    // When the LLM classifies this as a read-only query, bypass the heavy
    // creation pipeline (schema-fetch / wizard / plan-generator / HITL gate).
    // Store `intentKind` for the clarifier + result-formatter; set
    // `executionStatus=QUERY_INTENT` so the routing function sends us to the
    // query_handler node instead of schema_fetcher.
    if (output.kind === "query") {
      // For query intents, resourceType may be "UNSUPPORTED" (= "list all")
      // or a valid CFN type (= "list this type"). Either is fine for the
      // query-handler; we just don't run the creation validation path.
      const resolvedQueryType =
        output.resourceType !== "UNSUPPORTED" ? output.resourceType : undefined;
      log({
        ts: new Date().toISOString(),
        runId: state.runId,
        level: "info",
        action: LOG_ACTIONS.INTENT_PARSED,
        extras: { resourceType: resolvedQueryType ?? null, kind: "query" },
      });
      return {
        userIntent: safeIntent,
        intentKind: "query",
        executionStatus: ExecutionStatus.QUERY_INTENT,
        ...(resolvedQueryType ? { resourceType: resolvedQueryType } : {}),
      };
    }

    // ── Destroy-intent guardrail ──────────────────────────────────────────
    // When the LLM classifies this as a destroy intent, surface a clear
    // redirect message. We MUST NOT let kind=destroy reach the creation
    // pipeline — the user would see a CREATE plan for the resource they
    // intended to delete (the HITL gate prevents the actual write, but the
    // UX is broken and confusing).
    //
    // A dedicated destroy-routing node is deferred to a follow-up story.
    // Until that exists, we terminate with UNSUPPORTED_RESOURCE and an
    // actionable message pointing the user to `assignee destroy <arn>`.
    if (output.kind === "destroy") {
      const typeLabel =
        output.resourceType !== "UNSUPPORTED"
          ? output.resourceType
          : "resource";
      log({
        ts: new Date().toISOString(),
        runId: state.runId,
        level: "info",
        action: LOG_ACTIONS.INTENT_PARSED,
        extras: { kind: "destroy", resourceType: typeLabel },
      });
      return {
        userIntent: safeIntent,
        intentKind: "destroy",
        executionStatus: ExecutionStatus.UNSUPPORTED_RESOURCE,
        errorMessage:
          `I detected you want to destroy a ${typeLabel}. ` +
          `Use \`assignee destroy <arn>\` directly. ` +
          `Run \`assignee list\` to see managed ARNs.`,
      };
    }

    if (output.resourceType === "UNSUPPORTED") {
      log({
        ts: new Date().toISOString(),
        runId: state.runId,
        level: "warn",
        action: LOG_ACTIONS.INTENT_PARSED,
        extras: {
          outcome: "unsupported_resource",
          reason: "llm_returned_unsupported",
          kind: output.kind,
        },
      });
      return {
        userIntent: safeIntent,
        intentKind: isIntentKind(output.kind) ? output.kind : "create",
        executionStatus: ExecutionStatus.UNSUPPORTED_RESOURCE,
        errorMessage: `Unsupported resource type. ${SUPPORTED_TYPES_HINT}.`,
      };
    }
    const extraction = extractAssertedValues(safeIntent, output.resourceType);
    if (extraction.errors.length > 0) {
      return buildExtractionFailureUpdate(safeIntent, extraction);
    }
    log({
      ts: new Date().toISOString(),
      runId: state.runId,
      level: "info",
      action: LOG_ACTIONS.INTENT_PARSED,
      extras: {
        resourceType: output.resourceType,
        kind: output.kind,
        pattern: null,
      },
    });
    return {
      ...buildExtractionSuccessUpdate(
        safeIntent,
        extraction,
        state,
        {
          resourceType: output.resourceType,
        },
        existingResources,
        discoveryAdvisory,
      ),
      intentKind: isIntentKind(output.kind) ? output.kind : "create",
    };
  };
}

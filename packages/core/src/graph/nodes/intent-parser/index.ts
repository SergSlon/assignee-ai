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
} from "./extractors/compute-extractors.js";
import { extractResourceName } from "./extractors/name-extractor.js";
import { extractSnsProtocol } from "./extractors/messaging-extractors.js";
import {
  extractCloudWatchAlarmMetric,
  extractRetentionDays,
} from "./extractors/cloudwatch-extractor.js";

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

const intentParserSchema = z.object({
  resourceType: z.enum([...SUPPORTED_TYPES, "UNSUPPORTED"] as [
    string,
    ...string[],
  ]),
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
  extractResourceName(
    intent,
    resourceType,
    elicited,
    errors,
    advisories,
    errorCodeBox,
  );
  extractSgIngress(intent, elicited, errors);
  extractNoVpcDirective(intentLower, elicited);
  extractSnsProtocol(intent, intentLower, resourceType, elicited);
  extractRetentionDays(intent, intentLower, resourceType, elicited);
  extractCloudWatchAlarmMetric(intentLower, resourceType, elicited);

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
): Partial<AgentState> {
  const merged = mergeElicited(state.elicitedOptions, extraction.elicited);
  const mergedPresets = mergePresetFields(
    state.presetFields,
    extraction.elicited,
  );
  const mergedAdvisories = mergeAdvisories(
    state.advisories,
    extraction.advisories,
  );
  return {
    userIntent: safeIntent,
    ...resolution,
    ...(merged !== undefined ? { elicitedOptions: merged } : {}),
    ...(mergedPresets !== undefined ? { presetFields: mergedPresets } : {}),
    ...(mergedAdvisories !== undefined ? { advisories: mergedAdvisories } : {}),
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
      return buildExtractionSuccessUpdate(safeIntent, extraction, state, {
        resourceType: singletonType,
      });
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
      return buildExtractionSuccessUpdate(safeIntent, extraction, state, {
        resourcePattern: detectedPattern,
      });
    }

    // Step 4 — Bedrock classification on the sanitised intent.
    const prompt = `Classify this AWS infrastructure request into one of these types: ${SUPPORTED_TYPES.join(", ")} or UNSUPPORTED.
If the request says "standalone", "bare", "single", "on its own", or "just the X" (or otherwise explicitly asks for one resource in isolation), classify it as that exact type — do NOT reroute to a compound / multi-resource pattern even if the resource is usually deployed alongside others.
Events::Connection and Events::ApiDestination ARE first-class types in this list — classify as those when the intent is to create the Connection or ApiDestination itself, even without an accompanying Rule or EventBus.
RDS::DBInstance is first-class and MUST be classified as AWS::RDS::DBInstance when the request asks for a standalone database, regardless of whether a VPC / subnet group is mentioned.

Request: "${safeIntent}"`;
    const [err, output] = await llmClient.generateStructured(
      prompt,
      intentParserSchema,
      { callsite: "intent_parser", runId: state.runId },
    );
    if (err) {
      return {
        userIntent: safeIntent,
        executionStatus: ExecutionStatus.FAILED,
        errorMessage: `Intent parsing failed. Hint: check Bedrock connectivity and AWS credentials. Error: ${err.message}`,
      };
    }
    if (output.resourceType === "UNSUPPORTED") {
      return {
        userIntent: safeIntent,
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
      extras: { resourceType: output.resourceType, pattern: null },
    });
    return buildExtractionSuccessUpdate(safeIntent, extraction, state, {
      resourceType: output.resourceType,
    });
  };
}

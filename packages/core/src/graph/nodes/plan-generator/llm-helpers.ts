/**
 * Helpers for llm-plan.ts — kept in a separate file so the orchestrator
 * stays well below the SRP size budget. Each export has one reason to
 * change:
 *   - `readMemoryHints` → memory storage format
 *   - `buildPrompt` → LLM prompt wording
 *   - `parseLlmJsonResponse` → LLM response format
 *   - `unwrapCfnResourcesWrapper` → CFN wrapping safety net
 */
import {
  RESOURCE_TYPES,
  type ProvisionRecord,
  type FailureRecord,
} from "../../../index.js";
import { SCHEMA_EXCERPT_MAX_CHARS } from "../../../config/constants/limits.js";
import { TWENTY_FOUR_HOURS_MS } from "../../../config/constants/timeouts.js";
import {
  CloudFormationKey,
  CFN_RESOURCE_TYPE_PREFIX,
} from "../../../constants/cfn-keys.js";
import { log, LOG_ACTIONS } from "../../../utils/logger/index.js";
import { defaultMemoryService } from "../../../services/memory.js";
import { stripPromptBoundaryTags } from "../../../llm/prompt-sanitize.js";
import type { AgentState } from "../../graph-state.js";

/**
 * Story 19.3 + 19.4: reads previous provision + failure history for the
 * current resource type and synthesizes cost + warning hint strings.
 * Non-blocking — returns empty state on any memory read failure.
 * Story 20.13: skips failures older than the latest success for same type,
 * and also treats failures older than 24 hours as stale.
 */
export async function readMemoryHints(
  state: AgentState,
): Promise<{ provisionHintLine: string; memoryHints: string[] }> {
  let provisionHintLine = "";
  const memoryHints: string[] = [];
  try {
    const provisions = await defaultMemoryService.readProvisions();
    const previousForType = provisions
      .filter((p: ProvisionRecord) => p.resourceType === state.resourceType)
      .sort((a: ProvisionRecord, b: ProvisionRecord) =>
        b.timestamp.localeCompare(a.timestamp),
      );
    if (previousForType.length > 0) {
      const prev = previousForType[0]!;
      const dateStr = new Date(prev.timestamp).toLocaleDateString();
      provisionHintLine = `Previous provision of this type: ${prev.estimatedMonthlyCost}/month (run ${prev.runId}, ${dateStr}).`;
      memoryHints.push(provisionHintLine);
    }
  } catch (err) {
    log({
      ts: new Date().toISOString(),
      runId: state.runId,
      level: "info",
      action: LOG_ACTIONS.MEMORY_WRITE_FAILED,
      extras: { phase: "read_provisions", error: String(err) },
    });
  }

  try {
    const failures = await defaultMemoryService.readFailures();
    const previousFailuresForType = failures
      .filter((f: FailureRecord) => f.resourceType === state.resourceType)
      .sort((a: FailureRecord, b: FailureRecord) =>
        b.timestamp.localeCompare(a.timestamp),
      );
    // Only show provisioning failures (apply errors), not transient plan errors.
    const provisioningFailures = previousFailuresForType.filter(
      (f: FailureRecord) =>
        !f.errorMessage.includes("invalid JSON") &&
        !f.errorMessage.includes("Plan generator") &&
        !f.errorMessage.includes("Intent parsing"),
    );
    const latestFailure = provisioningFailures[0];
    if (latestFailure) {
      // Only show if failure is newer than latest success for this type.
      const provisions = await defaultMemoryService.readProvisions();
      const latestSuccess = provisions
        .filter((p: ProvisionRecord) => p.resourceType === state.resourceType)
        .sort((a: ProvisionRecord, b: ProvisionRecord) =>
          b.timestamp.localeCompare(a.timestamp),
        )[0];
      const failureIsStale =
        latestSuccess &&
        latestFailure.timestamp.localeCompare(latestSuccess.timestamp) <= 0;
      // Treat failures older than 24 hours as stale regardless of success history.
      const failureAge =
        Date.now() - new Date(latestFailure.timestamp).getTime();
      const failureIsTooOld = failureAge > TWENTY_FOUR_HOURS_MS;
      if (!failureIsStale && !failureIsTooOld) {
        const fixSuffix = latestFailure.suggestedFix
          ? ` Fix: ${latestFailure.suggestedFix}`
          : "";
        memoryHints.push(
          `\u26A0 Previous error with ${latestFailure.resourceType}: ${latestFailure.errorMessage}.${fixSuffix}`,
        );
      }
    }
  } catch (err) {
    log({
      ts: new Date().toISOString(),
      runId: state.runId,
      level: "info",
      action: LOG_ACTIONS.MEMORY_WRITE_FAILED,
      extras: { phase: "read_failures", error: String(err) },
    });
  }

  return { provisionHintLine, memoryHints };
}

/** Builds the plan-generator LLM prompt. Isolated so prompt tuning is localized. */
export function buildPrompt(input: {
  resourceType: string;
  userIntent: string;
  schemaKeys: string[];
  requiredKeys: string[];
  resourceSchema: Record<string, unknown>;
  resourceHints: string[];
  provisionHintLine: string;
}): string {
  const {
    resourceType,
    userIntent,
    schemaKeys,
    requiredKeys,
    resourceSchema,
    resourceHints,
    provisionHintLine,
  } = input;
  return [
    `You are an AWS resource configuration expert. Generate the resource properties JSON for a "${resourceType}" resource.`,
    // Story 54-it1-05 (L5-H1): symmetric tag + fence strip so an attacker
    // cannot break out of the <user_intent> block. The previous one-sided
    // `</user_intent>` strip left opening tags and nested <system> / code
    // fences intact. `stripPromptBoundaryTags` is defence-in-depth on top
    // of `sanitizeUserIntent` (NFR-16) applied upstream in intent-parser.
    `User intent: <user_intent>${stripPromptBoundaryTags(userIntent)}</user_intent>`,
    "",
    `Required properties: ${JSON.stringify(requiredKeys)}`,
    `Available properties: ${JSON.stringify(schemaKeys)}`,
    "",
    "RULES:",
    "1. Output ONLY valid JSON — no markdown fences, no explanation",
    "2. Output a FLAT JSON object with ONLY the resource properties directly — do NOT wrap in a CloudFormation Resources block or nest under a logical resource ID",
    "3. Include ONLY properties from the Available properties list",
    "4. Include ALL Required properties with real values",
    "5. Include properties clearly implied by the user's intent (e.g. InstanceType, Engine, FunctionName, Runtime)",
    "6. OMIT any property you don't have a specific value for — do NOT use empty strings, 0, false, or [] as placeholders",
    "7. NEVER use placeholder or example values from schema descriptions (e.g., ami-0abcdef1234567890, my-key-pair, subnet-0abc1234, sg-0123456789abcdef0, arn:aws:iam::123456789012:role/my-role, my-instance-profile, my-bucket, my-resource). If the user did not provide a real value, OMIT the property entirely.",
    "8. For S3 BucketName: use only lowercase letters, digits, hyphens (3–63 chars)",
    ...(resourceHints.length > 0
      ? [
          "",
          "RESOURCE-SPECIFIC RULES (take precedence over general rules above):",
          ...resourceHints.map((h, i) => `R${i + 1}. ${h}`),
        ]
      : []),
    ...(provisionHintLine ? ["", `COST CONTEXT: ${provisionHintLine}`] : []),
    "",
    'CORRECT format example: { "BucketName": "payments-data-prod" }',
    `WRONG format example: { "MyBucket": { "Type": "${RESOURCE_TYPES.S3_BUCKET}", "Properties": { "BucketName": "payments-data-prod" } } }`,
    "",
    `Schema excerpt:\n${JSON.stringify(resourceSchema, null, 2).slice(0, SCHEMA_EXCERPT_MAX_CHARS)}`,
    "",
    "Output the flat properties JSON object now:",
  ].join("\n");
}

/** Parses the LLM response text into a JSON object, stripping markdown fences. */
export function parseLlmJsonResponse(text: string): Record<string, unknown> {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\n?/, "")
    .replace(/\n?```$/, "");
  return JSON.parse(cleaned) as Record<string, unknown>;
}

/**
 * Safety net: unwraps the CloudFormation Resources-section wrapper the LLM
 * occasionally emits: `{ "LogicalId": { "Type": "AWS::...", "Properties": {...} } }`
 * → returns the inner Properties object. Returns input unchanged when not wrapped.
 */
export function unwrapCfnResourcesWrapper(
  desiredState: Record<string, unknown>,
): Record<string, unknown> {
  const topValues = Object.values(desiredState);
  if (
    topValues.length === 1 &&
    typeof topValues[0] === "object" &&
    topValues[0] !== null
  ) {
    const inner = topValues[0] as Record<string, unknown>;
    if (
      typeof inner[CloudFormationKey.TYPE] === "string" &&
      (inner[CloudFormationKey.TYPE] as string).startsWith(
        CFN_RESOURCE_TYPE_PREFIX,
      ) &&
      typeof inner[CloudFormationKey.PROPERTIES] === "object"
    ) {
      return inner[CloudFormationKey.PROPERTIES] as Record<string, unknown>;
    }
  }
  return desiredState;
}

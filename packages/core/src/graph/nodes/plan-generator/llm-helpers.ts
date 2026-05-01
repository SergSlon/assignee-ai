/**
 * Core helpers for llm-plan.ts — kept in a separate file so the orchestrator
 * stays well below the SRP size budget. Each export has one reason to change:
 *   - `readMemoryHints` → memory storage format
 *   - `buildPrompt` → LLM prompt wording
 *   - `parseLlmJsonResponse` → LLM response format
 *   - `unwrapCfnResourcesWrapper` → CFN wrapping safety net
 *
 * Plan-time validators (Epic 92 Wave 2.d) have been extracted to the sibling
 * file `llm-validators.ts`. Import `validatePlanShape` and individual
 * `validate*` functions from there.
 *
 * Additionally, rule 7's placeholder-example list in `buildPrompt` is now
 * resource-type-aware so SNS/SQS/Route53/etc. prompts don't list IAM role
 * ARN or instance-profile examples (observability leak noted by agent C).
 */
import { RESOURCE_TYPES } from "@/index.js";
import { SCHEMA_EXCERPT_MAX_CHARS } from "@/config/constants/limits.js";
import { TWENTY_FOUR_HOURS_MS } from "@/config/constants/timeouts.js";
import {
  CloudFormationKey,
  CFN_RESOURCE_TYPE_PREFIX,
} from "@/constants/cfn-keys.js";
import { log, LOG_ACTIONS } from "@/utils/logger/index.js";
// Epic 92 Wave 4.c F-D-34 — name-matching scope tightening + metadata
// scrub for the "Previous error" hint. Epic 94 e94.N10 then routes
// `readMemoryHints` through the scoped readers so cross-project /
// cross-intent records are filtered out before name-mismatch + staleness
// checks run. See `readMemoryHints` below.
import {
  extractDesiredNameFromErrorMessage,
  extractDesiredNameFromState,
  readScopedFailures,
  readScopedProvisions,
  scrubEmptyErrorMetadata,
} from "@/services/cost-history/index.js";
import { stripPromptBoundaryTags } from "@/llm/prompt-sanitize.js";
// W10-07 (P051 → L3-F16): redact account IDs and sensitive resource names
// from user-supplied intent before it enters the LLM prompt boundary.
import { redactArnsInString } from "@/utils/arn-redactor.js";
import type { AgentState } from "../../graph-state.js";

/**
 * Story 19.3 + 19.4: reads previous provision + failure history for the
 * current resource type and synthesizes cost + warning hint strings.
 * Non-blocking — returns empty state on any memory read failure.
 * Story 20.13: skips failures older than the latest success for same type,
 * and also treats failures older than 24 hours as stale.
 *
 * Epic 94 e94.N10 — B-08 HIGH NEW scope-tightening. Routes both reads
 * through the scoped readers (`readScopedProvisions` /
 * `readScopedFailures` from `services/cost-history/index.ts`) so
 * `{projectDir, intentHash}` contradicting records are filtered out
 * before the name-mismatch + staleness gates run. Wave 4.c added the
 * scoped reader infrastructure; this story wires it into the actual
 * hint call site so cross-project / cross-intent leakage stops. Legacy
 * records without sidecar entries still surface (the scoped reader
 * treats missing scope axes as non-contradicting — that's backward
 * compat by design and is what the existing plan-generator test suite
 * exercises).
 */
export async function readMemoryHints(
  state: AgentState,
): Promise<{ provisionHintLine: string; memoryHints: string[] }> {
  let provisionHintLine = "";
  const memoryHints: string[] = [];
  try {
    const previousForType = await readScopedProvisions(state);
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
    const previousFailuresForType = await readScopedFailures(state);
    // Only show provisioning failures (apply errors), not transient plan errors.
    const provisioningFailures = previousFailuresForType.filter(
      (f) =>
        !f.errorMessage.includes("invalid JSON") &&
        !f.errorMessage.includes("Plan generator") &&
        !f.errorMessage.includes("Intent parsing"),
    );
    const latestFailure = provisioningFailures[0];
    if (latestFailure) {
      // Only show if failure is newer than latest success for this type.
      // Scoped reader ensures the success list obeys the same
      // project / intent scope as the failure list, so staleness
      // comparisons stay apples-to-apples.
      const latestSuccess = (await readScopedProvisions(state))[0];
      const failureIsStale =
        latestSuccess &&
        latestFailure.timestamp.localeCompare(latestSuccess.timestamp) <= 0;
      // Treat failures older than 24 hours as stale regardless of success history.
      const failureAge =
        Date.now() - new Date(latestFailure.timestamp).getTime();
      const failureIsTooOld = failureAge > TWENTY_FOUR_HOURS_MS;
      if (!failureIsStale && !failureIsTooOld) {
        // Epic 92 Wave 4.c F-D-34 — name-matching scope tightening.
        // Pre-fix behaviour printed every previous error whose
        // resource type + staleness window matched, even when the
        // error clearly referred to a different resource name
        // (F-CROSS-001 repro: slice-A's `dogfood-e92-a-s3-1776800919
        // already exists` leaked into slice-D's plan for a fresh bucket).
        //
        // Without schema support for a stored `desiredName`, derive
        // both sides at read time:
        //   - prior: parse the failure's errorMessage for a leading
        //     identifier token (best-effort; real AWS SDK messages put
        //     the offending name up front).
        //   - current: pull the primary-identifier from `state.desiredState`
        //     when earlier nodes populated it, else extract a `named
        //     <token>` / `called <token>` reference from the user intent.
        //
        // Only when BOTH extractions succeed AND the names differ do
        // we skip the hint. Either-side-undefined falls back to the
        // existing scope (type + stale + 24h) — important so a
        // legitimate same-name retry still surfaces its prior failure.
        const priorName = extractDesiredNameFromErrorMessage(
          latestFailure.errorMessage,
        );
        const currentName = extractDesiredNameFromState({
          desiredState: state.desiredState,
          userIntent: state.userIntent,
        });
        const nameMismatch =
          priorName !== undefined &&
          currentName !== undefined &&
          priorName !== currentName;
        if (!nameMismatch) {
          const fixSuffix = latestFailure.suggestedFix
            ? ` Fix: ${latestFailure.suggestedFix}`
            : "";
          // F-D-34 scrub: strip `Status Code: 0`, `Request ID: null`,
          // and empty `(Service: X)` parentheticals so the user sees
          // an actionable message rather than AWS SDK placeholder
          // machinery.
          const cleanMessage = scrubEmptyErrorMetadata(
            latestFailure.errorMessage,
          );
          // W10-07: redact any ARNs (account IDs, bucket names) that leaked
          // into the stored error message before including in LLM context.
          const cleanMessageRedacted = redactArnsInString(cleanMessage);
          memoryHints.push(
            `\u26A0 Previous error with ${latestFailure.resourceType}: ${cleanMessageRedacted}.${fixSuffix}`,
          );
        }
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

/**
 * Story 92-2d — placeholder examples by resource-type family.
 *
 * Rule 7 in the plan-generator prompt previously listed Lambda-context
 * placeholders (IAM role ARN, instance profile) for every resource type,
 * which leaked Lambda-specific examples into SNS/SQS/Route53 prompts. This
 * table restricts the example list to the families where each placeholder
 * is actually relevant, so an SNS prompt sees `my-topic` + `my-resource`
 * and not `arn:aws:iam::123456789012:role/my-role`.
 *
 * The examples remain non-exhaustive — NEVER use them is still the rule.
 */
const UNIVERSAL_PLACEHOLDER_EXAMPLES = ["my-resource"] as const;

const PLACEHOLDER_EXAMPLES_BY_TYPE: Record<string, readonly string[]> = {
  [RESOURCE_TYPES.EC2_INSTANCE]: [
    "ami-0abcdef1234567890",
    "my-key-pair",
    "subnet-0abc1234",
    "sg-0123456789abcdef0",
  ],
  [RESOURCE_TYPES.LAMBDA_FUNCTION]: [
    "arn:aws:iam::123456789012:role/my-role",
    "my-function",
  ],
  [RESOURCE_TYPES.IAM_ROLE]: ["arn:aws:iam::123456789012:role/my-role"],
  [RESOURCE_TYPES.S3_BUCKET]: ["my-bucket"],
  [RESOURCE_TYPES.RDS_DB_INSTANCE]: [
    "subnet-0abc1234",
    "sg-0123456789abcdef0",
    "my-db-subnet-group",
  ],
  [RESOURCE_TYPES.SNS_TOPIC]: ["my-topic"],
  [RESOURCE_TYPES.SQS_QUEUE]: ["my-queue"],
  [RESOURCE_TYPES.DYNAMODB_TABLE]: ["my-table"],
  [RESOURCE_TYPES.EC2_VPC]: ["vpc-0123456789abcdef0"],
  [RESOURCE_TYPES.EC2_SUBNET]: ["subnet-0abc1234", "vpc-0123456789abcdef0"],
  [RESOURCE_TYPES.EC2_SECURITY_GROUP]: [
    "sg-0123456789abcdef0",
    "vpc-0123456789abcdef0",
  ],
};

/**
 * Returns the resource-type-appropriate placeholder example list for prompt
 * rule 7. Unknown types fall back to the universal list (`my-resource`).
 * Exported for testing.
 */
export function placeholderExamplesForType(
  resourceType: string,
): readonly string[] {
  const specific = PLACEHOLDER_EXAMPLES_BY_TYPE[resourceType];
  if (specific && specific.length > 0) {
    return [...specific, ...UNIVERSAL_PLACEHOLDER_EXAMPLES];
  }
  return UNIVERSAL_PLACEHOLDER_EXAMPLES;
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
  const placeholderExamples =
    placeholderExamplesForType(resourceType).join(", ");
  return [
    `You are an AWS resource configuration expert. Generate the resource properties JSON for a "${resourceType}" resource.`,
    // Story 54-it1-05 (L5-H1): symmetric tag + fence strip so an attacker
    // cannot break out of the <user_intent> block. The previous one-sided
    // `</user_intent>` strip left opening tags and nested <system> / code
    // fences intact. `stripPromptBoundaryTags` is defence-in-depth on top
    // of `sanitizeUserIntent` (NFR-16) applied upstream in intent-parser.
    // W10-07 (P051 → L3-F16): redact ARNs (account IDs + sensitive resource
    // names) from user intent before LLM sees it. Applied after boundary-tag
    // strip so the two sanitisers compose without interfering.
    `User intent: <user_intent>${redactArnsInString(stripPromptBoundaryTags(userIntent))}</user_intent>`,
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
    // Story 92-2d — rule 7 example list is resource-type-aware so SNS/SQS/
    // Route53/etc. prompts don't list Lambda-context placeholders.
    `7. NEVER use placeholder or example values from schema descriptions (e.g., ${placeholderExamples}). If the user did not provide a real value, OMIT the property entirely.`,
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

// Re-export validators for backward compatibility with existing callers
// (plan-generator.ts imports validatePlanShape from "./plan-generator/llm-helpers.js").
export {
  validatePlanShape,
  validateDynamoDbKeySchema,
  validateCloudFrontOrigins,
  validateIamRoleShape,
  validateLambdaCodeShape,
  validateEc2InstanceShape,
  validateSqsQueueShape,
  validateSnsTopicShape,
  validateSsmParameterShape,
  validateLogsLogGroupShape,
  validateApiGatewayV2ApiShape,
  validateSecretsManagerSecretShape,
  validateEc2VpcShape,
  validateEc2SubnetShape,
  validateRdsDbSubnetGroupShape,
  validateCloudWatchAlarmShape,
  validateElbv2LoadBalancerShape,
  validateEfsFileSystemShape,
  validateEventsRuleShape,
  validateKmsKeyShape,
  validateEc2SecurityGroupShape,
  validateEc2RouteTableShape,
  validateEc2NatGatewayShape,
} from "./llm-validators.js";

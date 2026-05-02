/**
 * Bedrock region/availability error detection + model lifecycle pre-flight.
 *
 * feedback_bedrock_region_error_hints: wrap Bedrock access errors with an
 * actionable hint naming the current AWS_REGION, the model, and the
 * suggested fix. Returns null when the error is something else (network,
 * throttling, missing creds, generic 5xx) so the caller falls back to the
 * original error message.
 *
 * PR-007 (W24b-S2): detectBedrockModelLifecycle calls GetFoundationModel and
 * inspects modelLifecycle.status. Returns ACTIVE/LEGACY + optional EOL date
 * and successor hint. Callers (doctor check) emit a [!] warning when LEGACY.
 *
 * Lifted from `apps/cli/src/services/llm-adapter/bedrock-region.ts` in
 * Story 50-4 Wave 5.1. The CLI's old path becomes a thin re-export shim.
 */
import { KNOWN_BEDROCK_REGIONS } from "../constants/bedrock-regions.js";
import { LlmProvider } from "../constants/llm-providers.js";

export { KNOWN_BEDROCK_REGIONS };

// ---------------------------------------------------------------------------
// Bedrock model lifecycle pre-flight (PR-007 / W24b-S2)
// ---------------------------------------------------------------------------

/** The shape of the lifecycle response modelDetails block. */
export interface BedrockFoundationModelLifecycle {
  status?: string;
  endOfLifeTime?: Date;
  legacyTime?: Date;
}

/** Minimal interface so the function can be tested without the real SDK client. */
export interface BedrockLifecycleClient {
  send(command: unknown): Promise<{
    modelDetails?: {
      modelLifecycle?: BedrockFoundationModelLifecycle;
    };
  }>;
}

/**
 * Factory that constructs a GetFoundationModelCommand object.
 * Provided by the caller so `packages/core` does not depend on
 * `@aws-sdk/client-bedrock` directly.
 */
export type GetFoundationModelCommandFactory = (modelId: string) => unknown;

/** Result shape returned by detectBedrockModelLifecycle. */
export interface BedrockModelLifecycleResult {
  /** "ACTIVE" — model is fully available; "LEGACY" — deprecated, plan to migrate. */
  status: "ACTIVE" | "LEGACY";
  /** ISO-8601 date string when the model will no longer be usable, if known. */
  endOfLifeDate?: string;
  /** ISO-8601 date string when the model entered legacy status, if known. */
  legacyDate?: string;
}

/**
 * Query the Bedrock control plane for the lifecycle status of `modelId`.
 *
 * `packages/core` does NOT depend on `@aws-sdk/client-bedrock` — the caller
 * (CLI doctor check) builds the command and passes it in via `commandFactory`.
 *
 * @param modelId         - Bare Bedrock model ID (e.g. "amazon.nova-lite-v1:0").
 * @param client          - A BedrockLifecycleClient (real BedrockClient or mock).
 * @param commandFactory  - Constructs a GetFoundationModelCommand from modelId.
 * @returns               - BedrockModelLifecycleResult on success, null when
 *                          the SDK throws. Null = "could not determine".
 *                          Callers must NOT treat null as LEGACY.
 */
export async function detectBedrockModelLifecycle(
  modelId: string,
  client: BedrockLifecycleClient,
  commandFactory: GetFoundationModelCommandFactory,
): Promise<BedrockModelLifecycleResult | null> {
  try {
    const command = commandFactory(modelId);
    const response = await client.send(command);

    const lifecycle = response?.modelDetails?.modelLifecycle;
    if (!lifecycle?.status) {
      // API returned no lifecycle block — treat as ACTIVE (unknown = safe).
      return { status: "ACTIVE" };
    }

    const rawStatus = lifecycle.status.toUpperCase();
    const status: "ACTIVE" | "LEGACY" =
      rawStatus === "LEGACY" ? "LEGACY" : "ACTIVE";

    const result: BedrockModelLifecycleResult = { status };
    if (lifecycle.endOfLifeTime instanceof Date) {
      result.endOfLifeDate = lifecycle.endOfLifeTime.toISOString().slice(0, 10);
    }
    if (lifecycle.legacyTime instanceof Date) {
      result.legacyDate = lifecycle.legacyTime.toISOString().slice(0, 10);
    }
    return result;
  } catch {
    // ResourceNotFoundException = model not found in this region/account.
    // AccessDeniedException = no bedrock:GetFoundationModel permission.
    // Any other error = network, throttle, etc.
    // In all cases return null so the caller silently skips the sub-check.
    return null;
  }
}

/**
 * Classify the AWS partition from the region string.
 *
 * PR-016/017 (W24b-S3): partition-aware hints prevent GovCloud / China
 * operators from seeing a commercial-region suggestion list that is
 * inapplicable to their environment.
 *
 * W24c-S0 (OOS-2): ISO partitions (us-iso-*, us-isob-*, eu-isoe-*) were
 * previously falling through to "commercial", producing wrong region
 * suggestions for ISO operators. Extended to 4-way classification:
 * commercial | govcloud | china | iso.
 *
 * feedback_partition_aware_arn_matching: never use literal "arn:aws:" or
 * exact region prefixes — always check via the ^arn:aws[\w-]*: pattern for
 * ARNs, and startsWith("us-gov-") / startsWith("cn-") for regions.
 */
function classifyPartition(
  region: string,
): "govcloud" | "china" | "iso" | "commercial" {
  if (region.startsWith("us-gov-")) return "govcloud";
  if (region.startsWith("cn-")) return "china";
  // ISO partitions: aws-iso (us-iso-*), aws-iso-b (us-isob-*), aws-iso-e (eu-isoe-*)
  if (
    region.startsWith("us-iso-") ||
    region.startsWith("us-isob-") ||
    region.startsWith("eu-isoe-")
  )
    return "iso";
  return "commercial";
}

export function detectBedrockRegionError(
  err: unknown,
  region: string,
  modelString: string,
): string | null {
  if (!modelString.startsWith(`${LlmProvider.BEDROCK}/`)) {
    return null;
  }

  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : "";
  if (!message) return null;

  const REGION_ERROR_PATTERNS = [
    /AccessDeniedException/i,
    /ValidationException/i,
    /ResourceNotFoundException/i,
    /could not resolve the foundation model/i,
    /the provided model identifier is invalid/i,
    /you don't have access to the model/i,
    /not authorized to invoke/i,
  ];

  if (!REGION_ERROR_PATTERNS.some((p) => p.test(message))) {
    return null;
  }

  const partition = classifyPartition(region);

  let suggestion: string;
  if (partition === "china") {
    // Bedrock is not available in the AWS China partition at all.
    suggestion =
      `Bedrock is not available in the AWS China partition. ` +
      `Set ASSIGNEE_LLM_DEFAULT to a non-Bedrock provider ` +
      `(e.g. anthropic/claude-sonnet-4-5 with ANTHROPIC_API_KEY set in your environment).`;
  } else if (partition === "govcloud") {
    // GovCloud has limited Bedrock availability — don't list commercial regions.
    suggestion =
      `GovCloud Bedrock regions: us-gov-west-1 ` +
      `(check https://docs.aws.amazon.com/govcloud-us/latest/UserGuide/govcloud-bedrock.html ` +
      `for current availability). ` +
      `Set AWS_REGION to a GovCloud region where Bedrock is available, ` +
      `OR set ASSIGNEE_LLM_DEFAULT to a non-Bedrock provider ` +
      `(e.g. anthropic/claude-sonnet-4-5 with ANTHROPIC_API_KEY set in your environment).`;
  } else if (partition === "iso") {
    // ISO partitions (aws-iso / aws-iso-b / aws-iso-e) have extremely limited
    // and classified Bedrock availability — do not suggest commercial regions.
    suggestion =
      `ISO-partition Bedrock availability is restricted and region-specific. ` +
      `Consult your agency network boundary documentation for available endpoints, ` +
      `OR set ASSIGNEE_LLM_DEFAULT to a non-Bedrock provider that is reachable ` +
      `from your ISO environment.`;
  } else {
    // Commercial partition — use the known region list.
    const onKnownRegion = KNOWN_BEDROCK_REGIONS.includes(region);
    suggestion = onKnownRegion
      ? `Your account may not be enrolled in this model in ${region}. Open the Bedrock console → Model access → request access to the model, OR set ASSIGNEE_LLM_DEFAULT to a different model that IS enabled in ${region}.`
      : `${region} is not on the canonical Bedrock-enabled list. Set AWS_REGION to one of: ${KNOWN_BEDROCK_REGIONS.join(", ")}, OR set ASSIGNEE_LLM_DEFAULT to a non-Bedrock provider (e.g. anthropic/claude-sonnet-4-5 with ANTHROPIC_API_KEY set in your environment).`;
  }

  return (
    `Bedrock model "${modelString}" is not available in AWS_REGION=${region}. ` +
    `${suggestion} ` +
    `Original AWS error: ${message}`
  );
}
